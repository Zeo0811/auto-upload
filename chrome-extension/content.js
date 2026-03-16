(function () {
  'use strict';

  // 防止重复注入
  if (window.__autoUploaderRunning) return;
  window.__autoUploaderRunning = true;

  const IS_TOP_FRAME = window === window.top;

  const BASE_URL = 'http://127.0.0.1:7788';

  // -------------------------------------------------------------------------
  // 工具函数
  // -------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function postJSON(path, data) {
    try {
      await fetch(BASE_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (e) {
      console.warn('[Auto Upload] postJSON failed:', path, e);
    }
  }

  // -------------------------------------------------------------------------
  // 弹窗处理
  // -------------------------------------------------------------------------

  const DISMISS_TEXTS = ['允许', '好', 'OK', '继续', '同意', '我知道了', '不允许', '稍后', '跳过', '忽略'];

  function dismissPopups() {
    try {
      // 点击匹配文字的按钮
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if (!btn.offsetParent) continue;
        const text = (btn.innerText || btn.textContent || '').trim();
        if (DISMISS_TEXTS.some(t => text === t || text.includes(t))) {
          btn.click();
        }
      }
      // 点击各类关闭/取消图标
      const closeSelectors = [
        '[class*="close"]', '[class*="Close"]',
        '[class*="modal"] [class*="icon"]',
        '[aria-label="关闭"]', '[aria-label="close"]',
        '.d-modal__close', '.d-dialog__close',
      ];
      for (const sel of closeSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent) continue;
          if (['BUTTON', 'A', 'SPAN', 'DIV', 'I'].includes(el.tagName) || el.getAttribute('role') === 'button') {
            el.click();
          }
        }
      }
    } catch (e) {
      console.warn('[Auto Upload] dismissPopups error:', e);
    }
  }

  async function dismissPopupsRounds(rounds, interval) {
    for (let i = 0; i < rounds; i++) {
      dismissPopups();
      await sleep(interval);
    }
  }

  // -------------------------------------------------------------------------
  // 登录检测与处理
  // -------------------------------------------------------------------------

  const LOGIN_PENDING_KEY = '__au_login_pending';

  function isOnLoginPage() {
    const platform = getPlatform();
    if (platform === 'xiaohongshu') {
      if (location.pathname.includes('/login')) return true;
      const c = document.querySelector('.login-container');
      return !!(c && c.offsetParent);
    }
    if (platform === 'channels') {
      if (location.pathname.includes('/login')) return true;
      // 检测 .login-content 是否还可见（登录成功后会消失或隐藏）
      const loginContent = document.querySelector('.login-content');
      if (loginContent && loginContent.offsetParent !== null) return true;
      // 兜底：检测 QR 相关元素
      const hasQr = !!(document.querySelector('[class*="qrcode-wrap"], [class*="login-qrcode"]') ||
                Array.from(document.querySelectorAll('span,div')).some(el => el.childElementCount === 0 && (el.textContent || '').includes('微信扫码登录')));
      return hasQr;
    }
    if (platform === 'douyin') {
      // 抖音 SSO 登录页
      if (location.hostname.includes('sso.douyin.com')) return true;
      if (location.pathname.includes('/login')) return true;
      // 检测抖音登录面板（不检查 offsetParent，因为面板可能是 fixed 定位）
      const loginPanel = document.querySelector('#douyin_login_comp_flat_panel');
      if (loginPanel) return true;
      // 检测扫码二维码
      const qrImg = document.querySelector('#animate_qrcode_container img');
      if (qrImg) return true;
      return false;
    }
    return location.pathname.includes('/login');
  }

  async function checkAndHandleLogin(accountId) {
    if (!isOnLoginPage()) {
      await postJSON('/login_status', { account_id: accountId, status: 'ok' });
      return true;
    }
    const platform = getPlatform();
    if (platform === 'channels') return checkAndHandleChannelsLogin(accountId);
    if (platform === 'douyin')   return checkAndHandleDouyinLogin(accountId);
    return checkAndHandleXhsLogin(accountId);
  }

  // 小红书登录
  async function checkAndHandleXhsLogin(accountId) {
    // 重试获取二维码：点击切换 → 等待 QR 渲染 → 校验 base64 长度
    // 真正的二维码 data:image 长度一般 > 1000，图标通常 < 500
    const QR_MIN_LENGTH = 1000;
    let qrBase64 = '';

    for (let attempt = 0; attempt < 5; attempt++) {
      // 每次重试都尝试点击切换到二维码模式
      const qrSwitchBtn = document.querySelector('.login-box-container img:first-child');
      if (qrSwitchBtn) { qrSwitchBtn.click(); }
      await sleep(2000 + attempt * 1000);  // 逐次多等一点

      const allDataImgs = Array.from(document.querySelectorAll('img[src^="data:image"]'));
      const qrImg = allDataImgs.sort((a, b) => b.src.length - a.src.length)[0];
      if (qrImg && qrImg.src.length > QR_MIN_LENGTH) {
        qrBase64 = qrImg.src;
        console.log(`[Auto Upload] 小红书 QR 获取成功 (第 ${attempt + 1} 次, 长度: ${qrBase64.length})`);
        break;
      }
      console.log(`[Auto Upload] 小红书 QR 第 ${attempt + 1} 次未取到有效二维码, 最大图片长度: ${qrImg ? qrImg.src.length : 0}`);
    }

    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64: qrBase64,
    });

    localStorage.setItem(LOGIN_PENDING_KEY, accountId);
    const QR_TIMEOUT = 60 * 1000;  // 60 秒未扫码就报超时
    const deadline = Date.now() + QR_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!isOnLoginPage()) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'confirmed' });
        await sleep(500);
        chrome.runtime.sendMessage({ type: 'closeTab' });
        return true;
      }
    }
    localStorage.removeItem(LOGIN_PENDING_KEY);
    await postJSON('/login_status', { account_id: accountId, status: 'error', error: 'qr_timeout' });
    await sleep(500);
    chrome.runtime.sendMessage({ type: 'closeTab' });
    return false;
  }

  // 视频号：截取二维码区域
  async function captureChannelsQr() {
    const allContents = Array.from(document.querySelectorAll('.login-content'));
    const vw = window.innerWidth;
    const loginContent = allContents.reduce((best, el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return best;
      const cx = r.left + r.width / 2;
      if (!best) return el;
      const br = best.getBoundingClientRect();
      const bestCx = br.left + br.width / 2;
      return Math.abs(cx - vw / 2) < Math.abs(bestCx - vw / 2) ? el : best;
    }, null);
    let clip;
    if (loginContent) {
      loginContent.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(300);
      const r = loginContent.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        clip = {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          width: r.width,
          height: r.height,
        };
        console.log('[Auto Upload] 截图区域 .login-content:', clip);
      }
    } else {
      console.warn('[Auto Upload] 未找到 .login-content，将截全图');
    }
    const shot = await chrome.runtime.sendMessage({ type: 'captureScreenshot', ...(clip && { clip }) });
    const qr_base64 = shot?.ok ? shot.dataUrl : '';
    if (!qr_base64) {
      console.warn('[Auto Upload] 视频号截图失败:', shot?.error);
    } else {
      console.log('[Auto Upload] 视频号截图成功，长度:', qr_base64.length);
    }
    return qr_base64;
  }

  // 视频号登录
  async function checkAndHandleChannelsLogin(accountId) {
    // 等待 .login-content 出现（说明页面框架已加载）
    let loginContent = null;
    for (let i = 0; i < 60; i++) {
      loginContent = document.querySelector('.login-content');
      if (loginContent) break;
      await sleep(500);
    }

    // 再等 5 秒让 QR iframe 渲染完成（QR 在跨域 iframe 里，DOM 里看不到但像素会被截到）
    console.log('[Auto Upload] login-content 已出现，等待 QR iframe 渲染...');
    await sleep(5000);

    const qr_base64 = await captureChannelsQr();
    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64,
      qr_url: '',
    });

    localStorage.setItem(LOGIN_PENDING_KEY, accountId);
    const QR_TIMEOUT = 60 * 1000;  // 60 秒未扫码就报超时
    const deadline = Date.now() + QR_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(2000);

      // 登录成功：离开了登录页
      if (!isOnLoginPage()) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'confirmed' });
        await sleep(500);
        chrome.runtime.sendMessage({ type: 'closeTab' });
        return true;
      }

      // 二维码过期：立即报超时，让 Python 层重试
      const expired = Array.from(document.querySelectorAll('.qrcode-wrap .mask')).find(
        m => m.offsetParent && (m.innerText || '').includes('已过期')
      );
      if (expired) {
        console.log('[Auto Upload] 视频号二维码已过期');
        break;
      }
    }

    localStorage.removeItem(LOGIN_PENDING_KEY);
    await postJSON('/login_status', { account_id: accountId, status: 'error', error: 'qr_timeout' });
    // 关闭当前标签页，Python 层会打开新的
    chrome.runtime.sendMessage({ type: 'closeTab' });
    return false;
  }

  // 抖音登录
  async function checkAndHandleDouyinLogin(accountId) {
    // 等待登录面板加载
    for (let i = 0; i < 30; i++) {
      const panel = document.querySelector('#douyin_login_comp_flat_panel');
      const qrArea = document.querySelector('[class*="scan_qrcode_login"]');
      if (panel || qrArea) break;
      await sleep(1000);
    }
    await sleep(2000);

    // 获取 QR 码
    let qrBase64 = '';
    const QR_MIN_LENGTH = 1000;

    // QR 容器：#animate_qrcode_container > div.qrcode-xxx > img
    for (let attempt = 0; attempt < 5; attempt++) {
      // 精确选择器：#animate_qrcode_container 内的 img
      let qrImg = document.querySelector('#animate_qrcode_container img') ||
                  document.querySelector('[class*="scan_qrcode_login"] img') ||
                  document.querySelector('#douyin_login_comp_flat_panel img');

      // fallback: 找 class 包含 qrcode 的 div 内的 img
      if (!qrImg) {
        qrImg = document.querySelector('[class*="qrcode"] img');
      }

      if (qrImg && qrImg.src && qrImg.src.length > QR_MIN_LENGTH) {
        qrBase64 = qrImg.src;
        console.log(`[Auto Upload] 抖音 QR 获取成功 (第 ${attempt + 1} 次, 长度: ${qrBase64.length})`);
        break;
      }

      // fallback: 截图方式
      if (attempt >= 2) {
        const qrArea = document.querySelector('#animate_qrcode_container') ||
                        document.querySelector('[class*="scan_qrcode_login"]') ||
                        document.querySelector('#douyin_login_comp_flat_panel');
        if (qrArea) {
          qrArea.scrollIntoView({ block: 'center', behavior: 'instant' });
          await sleep(300);
          const r = qrArea.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const clip = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
            const shot = await chrome.runtime.sendMessage({ type: 'captureScreenshot', clip });
            if (shot?.ok && shot.dataUrl) { qrBase64 = shot.dataUrl; break; }
          }
        }
      }

      console.log(`[Auto Upload] 抖音 QR 第 ${attempt + 1} 次未取到有效二维码`);
      await sleep(2000);
    }

    console.log(`[Auto Upload] 抖音 QR 获取${qrBase64 ? '成功' : '失败'}，长度: ${qrBase64.length}`);

    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64: qrBase64,
    });

    localStorage.setItem(LOGIN_PENDING_KEY, accountId);
    const QR_TIMEOUT = 120 * 1000;  // 抖音扫码给 120 秒
    const deadline = Date.now() + QR_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(2000);
      // 登录成功：跳转到创作者中心
      if (!isOnLoginPage()) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'confirmed' });
        await sleep(500);
        chrome.runtime.sendMessage({ type: 'closeTab' });
        return true;
      }
      // 检测二维码过期
      const expiredText = Array.from(document.querySelectorAll('div,span,p')).some(
        el => el.childElementCount === 0 && /已过期|已失效|刷新/.test(el.textContent || '')
      );
      if (expiredText) {
        console.log('[Auto Upload] 抖音二维码已过期');
        break;
      }
    }

    localStorage.removeItem(LOGIN_PENDING_KEY);
    await postJSON('/login_status', { account_id: accountId, status: 'error', error: 'qr_timeout' });
    chrome.runtime.sendMessage({ type: 'closeTab' });
    return false;
  }

  // -------------------------------------------------------------------------
  // 平台检测
  // -------------------------------------------------------------------------

  function getPlatform() {
    const h = location.hostname;
    if (h.includes('xiaohongshu.com')) return 'xiaohongshu';
    if (h.includes('douyin.com'))      return 'douyin';
    if (h.includes('weixin.qq.com'))   return 'channels';
    return null;
  }

  // -------------------------------------------------------------------------
  // 任务分发
  // -------------------------------------------------------------------------

  async function runTask(task) {
    const platform = getPlatform();
    const manageType = task.meta && task.meta._manage_type;
    console.log('[Auto Upload] 平台:', platform, '任务:', task.task_id, manageType ? `管理操作: ${manageType}` : '上传');

    // 管理操作分发
    if (manageType) {
      return runManageTask(platform, task, manageType);
    }

    // 上传操作
    if (platform === 'xiaohongshu') return runXhsTask(task);
    if (platform === 'channels')    return runChannelsTask(task);
    if (platform === 'douyin')      return runDouyinTask(task);
    throw new Error('当前页面不是支持的平台: ' + location.hostname);
  }

  // -------------------------------------------------------------------------
  // 管理操作分发
  // -------------------------------------------------------------------------

  async function runManageTask(platform, task, manageType) {
    const { task_id, meta } = task;
    try {
      // 如果在登录页，先处理登录
      if (isOnLoginPage()) {
        console.log('[Auto Upload] 管理操作：检测到未登录，开始登录流程');
        const loggedIn = await checkAndHandleLogin('manage_' + platform);
        if (!loggedIn) {
          await postJSON('/task_result', { task_id, status: 'error', error: '登录失败' });
          chrome.runtime.sendMessage({ type: 'closeTab' });
          return;
        }
        // 登录成功后等待页面跳转到管理页
        await sleep(3000);
      }

      let result;
      if (platform === 'xiaohongshu') {
        if (manageType === 'list_posts')  result = await xhsListPosts(task_id, meta);
        else if (manageType === 'edit_post')   result = await xhsEditPost(task_id, meta);
        else if (manageType === 'delete_post') result = await xhsDeletePost(task_id, meta);
        else if (manageType === 'delete_all_posts') result = await xhsDeleteAllPosts(task_id, meta);
        else if (manageType === 'delete_batch') result = await xhsDeleteBatch(task_id, meta);
        else throw new Error(`不支持的管理操作: ${manageType}`);
      } else if (platform === 'channels') {
        if (manageType === 'list_posts')  result = await channelsListPosts(task_id, meta);
        else if (manageType === 'edit_post')   result = await channelsEditPost(task_id, meta);
        else if (manageType === 'delete_post') result = await channelsDeletePost(task_id, meta);
        else if (manageType === 'delete_all_posts') result = await channelsDeleteAllPosts(task_id, meta);
        else if (manageType === 'channels_edit_continue') {
          await channelsEditContinue(task_id, meta);
          result = { status: 'ok' };
        }
        else throw new Error(`不支持的管理操作: ${manageType}`);
      } else if (platform === 'douyin') {
        if (manageType === 'list_posts')  result = await douyinListPosts(task_id, meta);
        else if (manageType === 'edit_post')   result = await douyinEditPost(task_id, meta);
        else if (manageType === 'delete_post') result = await douyinDeletePost(task_id, meta);
        else if (manageType === 'delete_all_posts') result = await douyinDeleteAllPosts(task_id, meta);
        else if (manageType === 'delete_batch') result = await douyinDeleteBatch(task_id, meta);
        else throw new Error(`不支持的管理操作: ${manageType}`);
      } else {
        throw new Error(`平台 ${platform} 不支持管理操作`);
      }
      // _deferred 表示结果由后续任务回传（如视频号编辑跳转）
      if (!result?._deferred) {
        await postJSON('/task_result', { task_id, ...result });
        // 操作完成后关闭当前标签页，避免堆积
        chrome.runtime.sendMessage({ type: 'closeTab' });
      }
    } catch (e) {
      console.error('[Auto Upload] 管理操作失败:', e);
      await postJSON('/task_result', { task_id, status: 'error', error: e.message });
      chrome.runtime.sendMessage({ type: 'closeTab' });
    }
  }

  // -------------------------------------------------------------------------
  // 小红书上传流程
  // -------------------------------------------------------------------------

  async function runXhsTask(task) {
    const { task_id, meta } = task;
    console.log('[Auto Upload] 开始处理任务', task_id);

    try {
      // 0. 检查是否已登录
      if (isOnLoginPage()) {
        await checkAndHandleLogin('default');
        await sleep(3000);
      }

      // 1. 等待页面稳定
      await sleep(2000);

      // 2. 处理弹窗
      await dismissPopupsRounds(5, 800);
      await postJSON('/progress', { task_id, progress: 10, msg: '弹窗已清理' });

      // 3. 通过 background.js 用 chrome.debugger 直接设置文件（不需要下载）
      await postJSON('/progress', { task_id, progress: 15, msg: '准备注入文件' });

      if (!document.querySelector('input[type="file"]')) {
        throw new Error('未找到文件上传 input 元素');
      }

      const setResult = await chrome.runtime.sendMessage({
        type: 'setFileInput',
        filePath: task.file_path,
      });
      if (!setResult || !setResult.ok) {
        throw new Error('设置文件失败: ' + (setResult?.error || '未知错误'));
      }
      await postJSON('/progress', { task_id, progress: 25, msg: '文件已注入，等待上传完成' });

      // 5. 等待上传完成（最多 10 分钟）
      const uploadTimeout = 10 * 60 * 1000;
      const uploadStart = Date.now();
      let lastProgressText = '';
      let titleInputVisible = false;

      while (Date.now() - uploadStart < uploadTimeout) {
        await sleep(2000);

        // 每 6 秒处理一次弹窗
        const elapsed = Date.now() - uploadStart;
        if (elapsed % 6000 < 2200) {
          dismissPopups();
        }

        // 检测上传失败
        const bodyText = document.body.innerText || '';
        if (bodyText.includes('上传失败')) {
          throw new Error('检测到"上传失败"提示');
        }

        // 检测进度条文字
        const progressEl = document.querySelector('[class*="progress"]');
        if (progressEl) {
          const progressText = (progressEl.innerText || '').trim();
          if (progressText && progressText !== lastProgressText) {
            lastProgressText = progressText;
            await postJSON('/progress', { task_id, progress: 30, msg: `上传中: ${progressText}` });
          }
        }

        // 检测标题输入框出现（上传完成的信号）
        const titleInput = document.querySelector('input[placeholder*="标题"]');
        if (titleInput && titleInput.offsetParent) {
          titleInputVisible = true;
          await postJSON('/progress', { task_id, progress: 70, msg: '视频上传完成，填写表单' });
          break;
        }
      }

      if (!titleInputVisible) {
        throw new Error('等待上传完成超时（10分钟）');
      }

      // 6. 上传完成后再次处理弹窗
      await sleep(3000);
      await dismissPopupsRounds(4, 800);

      // 7. 填写标题（React 兼容方式）
      const titleEl = document.querySelector('input[placeholder*="标题"]');
      if (titleEl && meta && meta.title) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(titleEl, meta.title);
        titleEl.dispatchEvent(new Event('input', { bubbles: true }));
        titleEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await postJSON('/progress', { task_id, progress: 75, msg: '标题已填写' });

      // 8. 填写描述 + 话题
      // 优先 TipTap/ProseMirror 编辑器（小红书当前使用），兼容旧版 Quill 编辑器
      const descEl = document.querySelector(
        '.tiptap.ProseMirror[contenteditable="true"], .ql-editor, [contenteditable="true"][data-placeholder], textarea[placeholder*="描述"], textarea[placeholder*="内容"]'
      );
      if (descEl && meta) {
        descEl.focus();
        await sleep(300);
        // 清空
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        // 插入描述正文
        if (meta.description) {
          document.execCommand('insertText', false, meta.description);
          descEl.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(300);
        }

        // 逐个插入话题（同行，空格分隔）
        if (meta.tags && meta.tags.length > 0) {
          if (meta.description) {
            document.execCommand('insertText', false, ' ');
            await sleep(200);
          }
          for (const tag of meta.tags) {
            document.execCommand('insertText', false, `#${tag}`);
            descEl.dispatchEvent(new Event('input', { bubbles: true }));

            // 等话题建议弹窗出现（最多 2s）
            let topicPopup = null;
            for (let i = 0; i < 8; i++) {
              await sleep(250);
              topicPopup = document.querySelector('#creator-editor-topic-container, [class*="topic-container"], [class*="topic-list"]');
              if (topicPopup) break;
            }

            if (topicPopup) {
              // 点击第一个建议项选中话题，再按 Enter 确认
              const firstItem = topicPopup.querySelector('.item.is-selected') ||
                                topicPopup.querySelector('.item') ||
                                topicPopup.querySelector('[class*="item"]');
              if (firstItem) {
                firstItem.click();
                await sleep(400);
              }
              // Enter 确认选中
              descEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              descEl.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
              await sleep(300);
            } else {
              // 弹窗未出现，空格结束话题
              document.execCommand('insertText', false, ' ');
              await sleep(200);
            }
          }
        }
      }
      await postJSON('/progress', { task_id, progress: 80, msg: '描述已填写' });

      // 确保所有话题弹窗关闭后再继续
      await sleep(500);
      // 按 Escape 关闭残留的话题选择弹窗
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(300);
      // 点击编辑器外部收起任何残留弹窗
      const outsideEl = document.querySelector('.publish-page-content') || document.querySelector('.content-container') || document.body;
      outsideEl.click();
      await sleep(500);
      // 再次检查弹窗是否还在，强制移除
      const leftoverPopup = document.querySelector('#creator-editor-topic-container, [class*="topic-container"], [class*="topic-list"]');
      if (leftoverPopup) {
        descEl?.blur();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(300);
      }

      // 8.5 上传封面图
      if (meta && meta.cover_path) {
        // 等待视频转码完成：.stage .spin 存在说明还在转码，消失说明完成
        await postJSON('/progress', { task_id, progress: 81, msg: '等待视频转码完成...' });
        const transcodeTimeout = 5 * 60 * 1000;  // 最多等 5 分钟
        const transcodeStart = Date.now();
        while (Date.now() - transcodeStart < transcodeTimeout) {
          const spinning = document.querySelector('.stage .spin');
          const stageText = document.querySelector('.stage')?.textContent || '';
          if (!spinning && !stageText.includes('转码中')) {
            console.log('[Auto Upload] 视频转码完成');
            break;
          }
          // 上报转码进度
          const speedMatch = stageText.match(/当前速度：([\d.]+\S+)/);
          const remainMatch = stageText.match(/剩余时间：(\S+)/);
          const msg = `转码中${speedMatch ? ' ' + speedMatch[1] : ''}${remainMatch ? ' 剩余' + remainMatch[1] : ''}`;
          await postJSON('/progress', { task_id, progress: 81, msg });
          await sleep(3000);
        }
        await sleep(1000);

        await postJSON('/progress', { task_id, progress: 82, msg: '准备上传封面' });

        // Step 1: 滚到封面区域，点击 operator 展开上传面板（带重试）
        let coverUploaded = false;
        for (let coverAttempt = 0; coverAttempt < 3 && !coverUploaded; coverAttempt++) {
          if (coverAttempt > 0) {
            console.log(`[Auto Upload] 封面上传第 ${coverAttempt + 1} 次重试`);
            await sleep(2000);
          }

          const coverOperator = document.querySelector('.cover-plugin-preview .operator') ||
                                document.querySelector('.cover-plugin-preview [class*="operator"]');
          if (coverOperator) {
            coverOperator.scrollIntoView({ block: 'center' });
            await sleep(500);
            coverOperator.click();
            await sleep(2000);
          }

          // Step 2: 等待 .upload-btn 出现并可见
          let uploadBtn = null;
          for (let i = 0; i < 10; i++) {
            uploadBtn = document.querySelector('.upload-btn');
            if (uploadBtn && uploadBtn.offsetParent !== null) break;
            await sleep(500);
          }
          if (!uploadBtn) {
            console.warn('[Auto Upload] 封面上传按钮未出现，重试...');
            continue;
          }
          uploadBtn.scrollIntoView({ block: 'center' });
          await sleep(400);

          const coverResult = await chrome.runtime.sendMessage({
            type: 'interceptAndSetFile',
            filePath: meta.cover_path,
            clickSelector: '.upload-btn',
          });
          if (coverResult && coverResult.ok) {
            coverUploaded = true;
          } else {
            console.warn(`[Auto Upload] 封面上传失败 (第 ${coverAttempt + 1} 次):`, coverResult?.error);
          }
        }

        if (!coverUploaded) {
          console.warn('[Auto Upload] 封面上传最终失败，跳过封面设置');
          await postJSON('/progress', { task_id, progress: 84, msg: '封面上传失败，已跳过' });
        }

        // 以下步骤仅在封面上传成功时执行
        if (coverUploaded) {
        // 等待 Zeus 引擎加载封面（封面上传后需要一段时间渲染）
        await sleep(3000);

        // 只用文字匹配关闭弹窗（避免 [class*="close"] 误关封面编辑器）
        // 同时隐藏任何意外打开的 d-popover（如推荐封面浮层）
        for (let i = 0; i < 4; i++) {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
            if (!btn.offsetParent) continue;
            const text = (btn.innerText || btn.textContent || '').trim();
            if (DISMISS_TEXTS.some(t => text === t || text.includes(t))) btn.click();
          }
          // 强制隐藏意外打开的推荐封面 d-popover
          for (const pop of document.querySelectorAll('.d-popover')) {
            if (pop.offsetParent && pop.querySelector('.recommend-cover-container')) {
              pop.style.display = 'none';
            }
          }
          await sleep(600);
        }

        // Step 3: 切换封面比例
        // .ratio-select 是一个 hover 触发的下拉框，需要先 hover 再点击弹出的选项
        const targetRatio = (meta.cover_ratio || '3:4').replace(/：/g, ':').replace(/\s+/g, '');
        const normRatio = s => s.trim().replace(/：/g, ':').replace(/\s+/g, '');

        // 等待 .ratio-select 出现（最多 15s）
        let ratioTrigger = null;
        for (let i = 0; i < 30; i++) {
          ratioTrigger = document.querySelector('.ratio-select');
          if (ratioTrigger) break;
          await sleep(500);
        }

        if (ratioTrigger) {
          // 检查当前已选比例，相同则跳过
          const currentRatio = normRatio(ratioTrigger.querySelector('.ratio-text')?.innerText || '');
          if (currentRatio === targetRatio) {
            console.log('[Auto Upload] 封面比例已是目标值:', targetRatio, '，跳过');
          } else {
            console.log('[Auto Upload] 当前比例:', currentRatio, '→ 目标:', targetRatio);

            // hover .ratio-select 触发下拉浮层
            ratioTrigger.scrollIntoView({ block: 'center', inline: 'nearest' });
            await sleep(200);
            await chrome.runtime.sendMessage({ type: 'cdpHover', selector: '.ratio-select' });
            await sleep(800);

            // 等待下拉选项出现，找 innerText 精确匹配目标比例的选项
            let option = null;
            for (let i = 0; i < 10; i++) {
              // 下拉选项通常在 .ratio-select 同级/父级的浮层里，全局搜索文字匹配的可见元素
              const candidates = Array.from(document.querySelectorAll('*'))
                .filter(el =>
                  normRatio(el.innerText || '') === targetRatio &&
                  el.offsetParent !== null &&
                  !el.contains(ratioTrigger)  // 排除触发器本身
                );
              // 取最深层（最具体）的元素
              if (candidates.length > 0) {
                option = candidates.sort((a, b) => a.contains(b) ? 1 : b.contains(a) ? -1 : 0)[0];
                break;
              }
              await sleep(300);
            }

            if (option) {
              console.log('[Auto Upload] 找到比例选项:', option.tagName, option.className, option.innerText);
              const tmpId = '__xhs_ratio_' + Date.now();
              option.id = tmpId;
              const clickRes = await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${tmpId}` });
              option.id = '';
              console.log('[Auto Upload] 比例点击结果:', JSON.stringify(clickRes));
              await sleep(600);
            } else {
              console.warn('[Auto Upload] hover 后仍未找到比例选项:', targetRatio);
            }
          }
        } else {
          console.warn('[Auto Upload] 未找到 .ratio-select');
        }
        await sleep(500);

        // Step 4: 点击确认/完成按钮保存封面
        // 从封面编辑器容器向上找，也查全局可见按钮
        const coverConfirmBtn = (
          // 封面区域内的确认按钮
          Array.from(document.querySelectorAll(
            '[class*="cover"] button, [class*="Cover"] button, .cover-plugin button'
          )).find(btn => btn.offsetParent && /^(确认|确定|完成|保存|Done|OK)$/.test((btn.innerText || '').trim()))
        ) || (
          // fallback: 全局可见按钮
          Array.from(document.querySelectorAll('button')).find(btn => {
            if (!btn.offsetParent) return false;
            const t = (btn.innerText || '').trim();
            return t === '确认' || t === '确定' || t === '完成' || t === '保存';
          })
        );

        if (coverConfirmBtn) {
          coverConfirmBtn.click();
          await sleep(1200);
          await postJSON('/progress', { task_id, progress: 84, msg: '封面已设置并保存' });
        } else {
          // 没找到确认按钮，记录调试信息
          const allVisibleBtns = Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent)
            .map(b => (b.innerText || '').trim())
            .filter(t => t);
          console.warn('[Auto Upload] 未找到封面确认按钮，当前可见按钮:', allVisibleBtns);
          await postJSON('/progress', { task_id, progress: 84, msg: '封面已上传（未找到保存按钮: ' + allVisibleBtns.join('/') + '）' });
        }
        } // end if (coverUploaded)
      }

      // 8.6 定时发布
      if (meta && meta.publish_time) {
        await postJSON('/progress', { task_id, progress: 85, msg: '设置定时发布' });

        // publish_time 格式: "2026-03-16 08:00" 或 "2026-3-20 8:01"
        const [datePart, timePart] = meta.publish_time.split(' ');
        const [, , rawDay]  = datePart.split('-');
        const [rawHour, rawMin] = timePart.split(':');
        // 补零
        const targetDay = rawDay.padStart(2, '0');
        const targetHour = rawHour.padStart(2, '0');
        const targetMin = rawMin.padStart(2, '0');
        const targetDayNum = String(parseInt(rawDay, 10));
        console.log(`[Auto Upload] 定时发布: 日=${targetDay} 时=${targetHour} 分=${targetMin}`);

        // 辅助：scrollIntoView 后 CDP 点击（解决滚动容器坐标偏移）
        async function cdpClickEl(el) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          await sleep(200);
          const tid = '__xhs_tmp_' + Date.now();
          el.id = tid;
          await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${tid}` });
          el.id = '';
          await sleep(400);
        }

        // Step 0: 等待定时发布开关出现，并激活
        // 精确找到包含"定时发布"文字的 .custom-switch-card
        let scheduleCard = null;
        let scheduleSwitch = null;
        for (let i = 0; i < 10; i++) {
          const cards = Array.from(document.querySelectorAll('.custom-switch-card'));
          scheduleCard = cards.find(card => (card.textContent || '').includes('定时发布'));
          if (scheduleCard) {
            scheduleSwitch = scheduleCard.querySelector('.d-switch-simulator');
            if (scheduleSwitch) break;
          }
          await sleep(500);
        }
        if (scheduleSwitch && scheduleSwitch.classList.contains('unchecked')) {
          scheduleSwitch.scrollIntoView({ block: 'center' });
          await sleep(600);
          const swId0 = '__au_sw0_' + Date.now();
          scheduleSwitch.id = swId0;
          await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${swId0}` });
          scheduleSwitch.id = '';
          await sleep(1500);
          console.log('[Auto Upload] 定时发布开关已开启');
        }

        // 直接在日期输入框里填入时间值（避免打开选择器误触开关）
        const fullDateTime = `${datePart.replace(/\b(\d)\b/g, '0$1')} ${targetHour}:${targetMin}`;
        let dtInput = null;
        for (let i = 0; i < 10; i++) {
          dtInput = document.querySelector('.d-datepicker input, .d-datepicker-input-filter input');
          if (dtInput) break;
          await sleep(500);
        }
        if (dtInput) {
          dtInput.focus();
          await sleep(300);
          // 用 React/Vue 兼容方式设值
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(dtInput, fullDateTime);
          dtInput.dispatchEvent(new Event('input', { bubbles: true }));
          dtInput.dispatchEvent(new Event('change', { bubbles: true }));
          // 模拟回车确认
          dtInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          await sleep(500);
          dtInput.blur();
          await sleep(500);
          console.log(`[Auto Upload] 定时发布时间已填入: ${fullDateTime}`);
        } else {
          console.warn('[Auto Upload] 未找到日期输入框');
        }

        await postJSON('/progress', { task_id, progress: 87, msg: `定时发布已设置: ${meta.publish_time}` });
        await sleep(500);
      }

      // 发布前最终确认：如果是定时发布，确保开关开着（用 CDP 点击确保生效）
      const isScheduled = !!(meta && meta.publish_time);
      if (isScheduled) {
        // 循环检测并修复开关状态，最多重试 3 次
        for (let swRetry = 0; swRetry < 3; swRetry++) {
          const fCards = Array.from(document.querySelectorAll('.custom-switch-card'));
          const fCard = fCards.find(c => (c.textContent || '').includes('定时发布'));
          const fSwitch = fCard?.querySelector('.d-switch-simulator');
          if (!fSwitch || fSwitch.classList.contains('checked')) {
            console.log('[Auto Upload] 定时开关状态正常 (checked)');
            break;
          }
          console.log(`[Auto Upload] 发布前检测到定时开关关闭，第 ${swRetry + 1} 次重新开启`);
          // 用 CDP 点击开关
          fSwitch.scrollIntoView({ block: 'center' });
          await sleep(300);
          const swId = '__au_sw_' + Date.now();
          fSwitch.id = swId;
          await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${swId}` });
          fSwitch.id = '';
          await sleep(1500);
        }
      }

      let published = false;
      const targetBtnText = isScheduled ? '定时发布' : '发布';

      // 精确匹配：排除开关区域内的按钮
      const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
      for (const btn of allBtns) {
        // 排除在 .custom-switch-card 内的按钮（那是开关不是发布按钮）
        if (btn.closest('.custom-switch-card')) continue;
        const text = (btn.innerText || btn.textContent || '').trim();
        if (text === targetBtnText) {
          btn.removeAttribute('disabled');
          btn.click();
          published = true;
          console.log(`[Auto Upload] 点击「${targetBtnText}」按钮`);
          break;
        }
      }

      if (!published) {
        const finalBtns = allBtns
          .map(b => (b.innerText || '').trim())
          .filter(t => t);
        throw new Error(`未找到「${targetBtnText}」按钮，页面按钮: [${finalBtns.join(', ')}]`);
      }
      await postJSON('/progress', { task_id, progress: 90, msg: '已点击发布按钮' });

      // 10. 等待并持续清弹窗（5 秒）
      await dismissPopupsRounds(5, 1000);

      // 用 sendBeacon 保证页面跳转时也能发出（fetch 在页面卸载时会被中止）
      const postUrl = location.href;
      navigator.sendBeacon(BASE_URL + '/done', JSON.stringify({ task_id, post_url: postUrl }));
      console.log('[Auto Upload] 任务完成', task_id);
      chrome.runtime.sendMessage({ type: 'closeTab' });

    } catch (e) {
      console.error('[Auto Upload] 任务失败', task_id, e);
      navigator.sendBeacon(BASE_URL + '/fail', JSON.stringify({ task_id, error: e.message || String(e) }));
      chrome.runtime.sendMessage({ type: 'closeTab' });
    }
  }

  // -------------------------------------------------------------------------
  // 视频号上传流程
  // 架构：文件注入用 CDP setFileInput，表单操作用 CDP runInPage（页面 JS 上下文，可访问 iframe.contentDocument）
  // -------------------------------------------------------------------------

  // 在页面 JS 上下文执行表达式的辅助函数
  function runInPage(expression) {
    return chrome.runtime.sendMessage({ type: 'runInPage', expression });
  }

  async function runChannelsTask(task) {
    const { task_id, meta } = task;
    console.log('[Auto Upload] 视频号任务开始', task_id);

    try {
      await postJSON('/progress', { task_id, progress: 5, msg: '视频号：页面准备中' });

      // Step 1: 等页面稳定（Vue 组件 unmount/remount 需要时间）
      await sleep(3000);

      // Step 2: 向 iframe 内的隐藏 file input 注入文件（带重试，等元素出现）
      await postJSON('/progress', { task_id, progress: 10, msg: '视频号：注入视频文件' });
      let setResult = null;
      for (let fileAttempt = 0; fileAttempt < 15; fileAttempt++) {
        setResult = await chrome.runtime.sendMessage({
          type: 'setFileInput',
          filePath: task.file_path,
          selector: 'input[type="file"]',
        });
        if (setResult && setResult.ok) break;
        console.log(`[Auto Upload] 视频号 file input 未找到 (第${fileAttempt + 1}次)，等待...`);
        await sleep(2000);
      }
      if (!setResult || !setResult.ok) throw new Error('视频注入失败: ' + (setResult?.error || '未知'));

      // Step 3: 等待上传完成（用 runInPage 检测 iframe 内编辑器，间隔 5 秒减少 CDP 压力）
      await postJSON('/progress', { task_id, progress: 15, msg: '视频号：等待上传完成' });
      const uploadTimeout = 10 * 60 * 1000;
      const uploadStart = Date.now();
      let editorVisible = false;
      while (Date.now() - uploadStart < uploadTimeout) {
        await sleep(5000);
        try {
          const r = await runInPage(
            `!!(document.querySelector('iframe') && document.querySelector('iframe').contentDocument && document.querySelector('iframe').contentDocument.querySelector('.post-desc-box .input-editor'))`
          );
          if (r && r.result === true) { editorVisible = true; break; }
        } catch (e) {
          console.log('[Auto Upload] 视频号：等待编辑器出现...', e?.message || '');
        }
      }
      if (!editorVisible) throw new Error('等待上传完成超时');

      await postJSON('/progress', { task_id, progress: 70, msg: '视频号：上传完成，填写信息' });
      await sleep(1500);

      // Step 4: 填写标题 + 描述（在页面 JS 上下文操作 iframe DOM）
      const title = meta?.title || '';
      const desc = meta?.description || '';
      const tags = meta?.tags || [];
      let content = title;
      if (title && desc) content += '\n\n';
      content += desc;

      if (content) {
        await runInPage(`
          (function() {
            var el = document.querySelector('iframe').contentDocument.querySelector('.post-desc-box .input-editor');
            if (!el) return;
            el.focus();
            document.querySelector('iframe').contentDocument.execCommand('selectAll', false, null);
            document.querySelector('iframe').contentDocument.execCommand('delete', false, null);
            document.querySelector('iframe').contentDocument.execCommand('insertText', false, ${JSON.stringify(content)});
          })()
        `);
        await sleep(300);
      }

      // 插入话题标签
      for (const tag of tags) {
        await sleep(300);
        await runInPage(`
          document.querySelector('iframe').contentDocument.execCommand('insertText', false, ${JSON.stringify(' #' + tag)})
        `);
        await sleep(500);
      }

      await postJSON('/progress', { task_id, progress: 80, msg: '视频号：信息已填写' });

      // Step 4.5: 上传封面图
      if (meta?.cover_path) {
        await postJSON('/progress', { task_id, progress: 80, msg: '视频号：准备上传封面' });

        // 滚动 iframe 内容到封面区域，确保编辑按钮可见
        await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var doc = iframes[i].contentDocument;
                // 先滚动到底部，封面区域通常在下方
                var editBtn = doc.querySelector('.edit-btn');
                if (editBtn) { editBtn.scrollIntoView({ block: 'center' }); return; }
                // 兜底：滚动到表单底部
                var form = doc.querySelector('.post-desc-box') || doc.querySelector('.form-btns');
                if (form) form.scrollIntoView({ block: 'end' });
              } catch(e) {}
            }
          })()
        `);
        await sleep(1000);

        // 等待封面预览图完全加载（.edit-btn 可见，最多 90s）
        let editBtnReady = false;
        for (let i = 0; i < 45; i++) {
          const check = await runInPage(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var doc = iframes[i].contentDocument;
                  var editBtn = doc.querySelector('.edit-btn');
                  if (editBtn) {
                    editBtn.scrollIntoView({ block: 'center' });
                    if (editBtn.offsetParent) return true;
                  }
                } catch(e) {}
              }
              return false;
            })()
          `);
          if (check?.result === true) { editBtnReady = true; break; }
          await sleep(2000);
        }
        if (!editBtnReady) {
          console.warn('[Auto Upload] 等待封面编辑按钮超时');
        }
        await sleep(3000);

        // 上传封面的通用函数
        async function uploadCover(editBtnSelector, label) {
          // 点击"编辑"按钮
          const editResult = await chrome.runtime.sendMessage({
            type: 'cdpClickIframe',
            selector: editBtnSelector,
          });
          console.log(`[Auto Upload] ${label}编辑按钮点击:`, JSON.stringify(editResult));
          if (!editResult?.ok) return false;

          // 等待编辑器弹窗打开 + .add-icon 可见
          let addIconFound = false;
          for (let i = 0; i < 5; i++) {
            await sleep(1000);
            const check = await runInPage(`
              (function() {
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                  try {
                    var doc = iframes[i].contentDocument;
                    var dialog = doc.querySelector('.cover-set-footer');
                    if (!dialog) continue;
                    var els = doc.querySelectorAll('.add-icon');
                    for (var j = 0; j < els.length; j++) {
                      var r = els[j].getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) return { found: true };
                    }
                    return { found: false, dialogOpen: true };
                  } catch(e) {}
                }
                return { found: false, dialogOpen: false };
              })()
            `);
            if (check?.result?.found) { addIconFound = true; break; }
            // 弹窗已打开但没有 .add-icon，无需继续等待
            if (check?.result?.dialogOpen) break;
          }

          // 如果 .add-icon 未出现，可能需要先点击 .cover-tips 进入分享卡片编辑模式
          if (!addIconFound) {
            console.log(`[Auto Upload] ${label} 尝试点击 .cover-tips 进入编辑模式`);
            await chrome.runtime.sendMessage({
              type: 'cdpClickIframe',
              selector: '.cover-tips',
            });
            await sleep(3000);
            // 再次等待 .add-icon（最多 10s）
            for (let i = 0; i < 10; i++) {
              await sleep(1000);
              const check = await runInPage(`
                (function() {
                  var iframes = document.querySelectorAll('iframe');
                  for (var i = 0; i < iframes.length; i++) {
                    try {
                      var els = iframes[i].contentDocument.querySelectorAll('.add-icon');
                      for (var j = 0; j < els.length; j++) {
                        var r = els[j].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return true;
                      }
                    } catch(e) {}
                  }
                  return false;
                })()
              `);
              if (check?.result === true) { addIconFound = true; break; }
            }
          }

          // 点击添加图标，触发文件选择对话框
          const coverResult = await chrome.runtime.sendMessage({
            type: 'setFileViaChooser',
            filePath: meta.cover_path,
            clickSelector: '.add-icon',
          });
          if (!coverResult?.ok) {
            console.warn(`[Auto Upload] ${label}封面上传失败:`, coverResult?.error);
            return false;
          }

          await sleep(3000);

          // 点击确认按钮
          await runInPage(`
            (function() {
              var btn = null;
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  btn = iframes[i].contentDocument.querySelector('.cover-set-footer .weui-desktop-btn_primary');
                  if (btn) break;
                } catch(e) {}
              }
              if (!btn) btn = document.querySelector('.cover-set-footer .weui-desktop-btn_primary');
              if (btn) btn.click();
            })()
          `);
          await sleep(2000);
          return true;
        }

        // 上传个人卡片封面
        await uploadCover('.vertical-img-wrap .edit-btn', '个人卡片');
        await postJSON('/progress', { task_id, progress: 83, msg: '视频号：个人卡片封面已上传' });

        // 上传分享卡片封面（横屏视频才有 .horizon-img-wrap）
        const hasHorizon = await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var el = iframes[i].contentDocument.querySelector('.horizon-img-wrap .edit-btn');
                if (el && el.offsetParent) return true;
              } catch(e) {}
            }
            return false;
          })()
        `);
        if (hasHorizon?.result === true) {
          // Step 1: 点击分享卡片编辑按钮
          await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.horizon-img-wrap .edit-btn' });
          await sleep(2000);

          // Step 2: 点击"分享卡片"文字
          await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.cover-tips' });
          await sleep(1500);

          // Step 3: 点击"使用素材"按钮
          await runInPage(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var btns = iframes[i].contentDocument.querySelectorAll('.weui-desktop-btn_primary');
                  for (var j = 0; j < btns.length; j++) {
                    if (btns[j].textContent.trim() === '使用素材') { btns[j].click(); return; }
                  }
                } catch(e) {}
              }
            })()
          `);
          await sleep(2000);

          // Step 4: 在裁剪器中拖动图片到顶部
          // 图片默认居中，需要往下拖让顶部显示在视口中
          const dragResult = await runInPage(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var vp = iframes[i].contentDocument.querySelector('.cr-viewport');
                  if (!vp) continue;
                  var img = iframes[i].contentDocument.querySelector('.cr-image');
                  if (!img) continue;
                  var vpRect = vp.getBoundingClientRect();
                  var imgRect = img.getBoundingClientRect();
                  var frRect = iframes[i].getBoundingClientRect();
                  return {
                    found: true,
                    // 视口和图片的绝对坐标
                    vpCx: frRect.left + vpRect.left + vpRect.width / 2,
                    vpCy: frRect.top + vpRect.top + vpRect.height / 2,
                    // 需要拖动的距离：图片顶部对齐视口顶部
                    dragY: vpRect.top - imgRect.top
                  };
                } catch(e) {}
              }
              return { found: false };
            })()
          `);
          console.log('[Auto Upload] 分享卡片裁剪器:', JSON.stringify(dragResult));

          if (dragResult?.result?.found && dragResult.result.dragY > 0) {
            const { vpCx, vpCy, dragY } = dragResult.result;
            // 用 CDP 模拟拖拽：从视口中心往下拖 dragY 像素
            await chrome.runtime.sendMessage({
              type: 'cdpDrag',
              startX: vpCx,
              startY: vpCy,
              endX: vpCx,
              endY: vpCy + dragY,
            });
            await sleep(1000);
          }

          // Step 5: 点击确认
          await runInPage(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var btns = iframes[i].contentDocument.querySelectorAll('.weui-desktop-btn_primary');
                  for (var j = btns.length - 1; j >= 0; j--) {
                    if (btns[j].offsetParent && btns[j].textContent.trim().match(/确认|完成|保存/)) {
                      btns[j].click(); return;
                    }
                  }
                } catch(e) {}
              }
            })()
          `);
          await sleep(2000);
          await postJSON('/progress', { task_id, progress: 85, msg: '视频号：分享卡片封面已上传' });
        } else {
          await postJSON('/progress', { task_id, progress: 85, msg: '视频号：封面已上传（无分享卡片）' });
        }
      }

      // Step 5: 定时发布（可选）
      if (meta?.publish_time) {
        await postJSON('/progress', { task_id, progress: 86, msg: '视频号：设置定时发布' });

        const [datePart, timePart] = meta.publish_time.split(' ');
        const [, , targetDay] = datePart.split('-');
        const [targetHour, targetMin] = timePart.split(':');
        const dayNum = String(parseInt(targetDay, 10));
        const hourStr = String(parseInt(targetHour, 10)).padStart(2, '0');
        const minStr = String(parseInt(targetMin, 10)).padStart(2, '0');

        // 点击"定时发布"单选按钮
        await runInPage(`
          var r = document.querySelector('iframe').contentDocument.querySelector('.weui-desktop-form__radio[value="1"]');
          if (r) r.click();
        `);
        await sleep(1000);

        // 点击日期输入框打开选择器（注意: placeholder 是"请选择发表时间"或"请选择时间"）
        await chrome.runtime.sendMessage({
          type: 'cdpClickIframe',
          selector: '.weui-desktop-form__input[placeholder*="选择"]',
        });
        await sleep(1000);

        // 选择日期
        const targetMonth = String(parseInt(datePart.split('-')[1], 10));
        await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var dayNum = ${JSON.stringify(dayNum)};
            var targetMonth = ${JSON.stringify(targetMonth)};
            var monthEl = doc.querySelector('.weui-desktop-picker__panel_month .weui-desktop-picker__selected');
            var curMonth = monthEl ? String(parseInt(monthEl.textContent, 10)) : '';
            if (curMonth && curMonth !== targetMonth) {
              var nextBtn = doc.querySelector('.weui-desktop-picker__panel_day .weui-desktop-picker__arrow_right') ||
                            doc.querySelector('.weui-desktop-picker__arrow:last-child');
              if (nextBtn) nextBtn.click();
            }
            setTimeout(function() {
              var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
              for (var i = 0; i < links.length; i++) {
                var a = links[i];
                if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
                if (a.textContent.trim() === dayNum) { a.click(); break; }
              }
            }, 300);
          })()
        `);
        await sleep(800);

        // 点击时间区域头部展开时间滚轮选择器
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-picker__dt' });
        await sleep(1000);

        // 尝试通过 CDP 滚轮选择时间（已知问题：视频号时间选择器的精确时间设置暂不生效，日期选择正常）
        const currentTime = await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var selH = doc.querySelector('.weui-desktop-picker__time__hour .weui-desktop-picker__selected');
            var selM = doc.querySelector('.weui-desktop-picker__time__minute .weui-desktop-picker__selected');
            return {
              hour: selH ? parseInt(selH.textContent.trim(), 10) : -1,
              minute: selM ? parseInt(selM.textContent.trim(), 10) : -1,
            };
          })()
        `);
        const curHour = currentTime?.result?.hour ?? -1;
        const curMin = currentTime?.result?.minute ?? 0;
        const tgtHour = parseInt(targetHour, 10);
        const tgtMin = parseInt(targetMin, 10);
        const hourDiff = tgtHour - curHour;
        const minDiff = tgtMin - curMin;

        const DELTA_PER_ITEM = 40;
        if (hourDiff !== 0) {
          const steps = Math.abs(hourDiff);
          const delta = hourDiff > 0 ? DELTA_PER_ITEM : -DELTA_PER_ITEM;
          for (let s = 0; s < steps; s++) {
            await chrome.runtime.sendMessage({ type: 'cdpScrollIframe', selector: '.weui-desktop-picker__dd__time', deltaY: delta });
            await sleep(200);
          }
          await sleep(500);
        }
        if (minDiff !== 0) {
          const steps = Math.abs(minDiff);
          const delta = minDiff > 0 ? DELTA_PER_ITEM : -DELTA_PER_ITEM;
          for (let s = 0; s < steps; s++) {
            await chrome.runtime.sendMessage({ type: 'cdpScrollIframe', selector: '.weui-desktop-picker__time__minute', deltaY: delta });
            await sleep(100);
          }
          await sleep(500);
        }

        // 点击空白关闭选择器
        await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var body = doc.querySelector('.form-btns') || doc.body;
            if (body) body.click();
          })()
        `);
        await sleep(500);

        await postJSON('/progress', { task_id, progress: 88, msg: '视频号：定时发布已设置 ' + meta.publish_time });
      }

      // Step 6: 等待视频上传完成（发表按钮不再 disabled），最多等 10 分钟
      await postJSON('/progress', { task_id, progress: 88, msg: '视频号：等待视频上传完成...' });
      const publishWaitStart = Date.now();
      const publishWaitTimeout = 10 * 60 * 1000;
      while (Date.now() - publishWaitStart < publishWaitTimeout) {
        const btnState = await runInPage(`
          (function() {
            try {
              var doc = document.querySelector('iframe').contentDocument;
              var btn = doc.querySelector('.form-btns button.weui-desktop-btn_primary');
              if (!btn) return { found: false };
              return { found: true, disabled: btn.disabled || btn.classList.contains('weui-desktop-btn_disabled') || btn.classList.contains('is-disabled'), text: btn.textContent.trim() };
            } catch(e) { return { found: false }; }
          })()
        `);
        if (btnState?.result?.found && !btnState.result.disabled) {
          console.log('[Auto Upload] 视频号发表按钮可用:', btnState.result.text);
          break;
        }
        if (btnState?.result?.found) {
          await postJSON('/progress', { task_id, progress: 89, msg: '视频号：视频上传中，等待完成...' });
        }
        await sleep(3000);
      }

      // 点击发表
      await sleep(500);
      const publishResult = await runInPage(`
        (function() {
          var btn = document.querySelector('iframe').contentDocument.querySelector('.form-btns button.weui-desktop-btn_primary');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!publishResult || !publishResult.result) throw new Error('未找到发表按钮');

      await postJSON('/progress', { task_id, progress: 90, msg: '视频号：已点击发表' });
      await sleep(3000);

      const postUrl = location.href;
      navigator.sendBeacon(BASE_URL + '/done', JSON.stringify({ task_id, post_url: postUrl }));
      console.log('[Auto Upload] 视频号任务完成', task_id);
      chrome.runtime.sendMessage({ type: 'closeTab' });

    } catch (e) {
      console.error('[Auto Upload] 视频号任务失败', task_id, e);
      navigator.sendBeacon(BASE_URL + '/fail', JSON.stringify({ task_id, error: e.message || String(e) }));
      chrome.runtime.sendMessage({ type: 'closeTab' });
    }
  }

  // -------------------------------------------------------------------------
  // 抖音上传流程
  // -------------------------------------------------------------------------

  async function runDouyinTask(task) {
    const { task_id, meta } = task;
    console.log('[Auto Upload] 抖音任务开始', task_id);

    try {
      // 0. 检查登录
      if (isOnLoginPage()) {
        await checkAndHandleLogin('default');
        await sleep(3000);
      }

      // 1. 等待页面稳定
      await sleep(3000);
      await dismissPopupsRounds(5, 800);
      await postJSON('/progress', { task_id, progress: 10, msg: '抖音：弹窗已清理' });

      // 2. 注入视频文件
      await postJSON('/progress', { task_id, progress: 15, msg: '抖音：准备注入文件' });
      let setResult = null;
      for (let fileAttempt = 0; fileAttempt < 15; fileAttempt++) {
        setResult = await chrome.runtime.sendMessage({
          type: 'setFileInput',
          filePath: task.file_path,
          selector: 'input[type="file"]',
        });
        if (setResult && setResult.ok) break;
        console.log(`[Auto Upload] 抖音 file input 未找到 (第${fileAttempt + 1}次)，等待...`);
        await sleep(2000);
      }
      if (!setResult || !setResult.ok) {
        throw new Error('视频注入失败: ' + (setResult?.error || '未知'));
      }
      await postJSON('/progress', { task_id, progress: 25, msg: '抖音：文件已注入，等待上传完成' });

      // 3. 等待上传完成（标题输入框出现或编辑器可用）
      const uploadTimeout = 10 * 60 * 1000;
      const uploadStart = Date.now();
      let editorReady = false;

      while (Date.now() - uploadStart < uploadTimeout) {
        await sleep(3000);

        // 每 9 秒处理一次弹窗
        const elapsed = Date.now() - uploadStart;
        if (elapsed % 9000 < 3500) dismissPopups();

        // 检测上传进度文字
        const progressEl = document.querySelector('[class*="progress"], [class*="upload-progress"], [class*="percent"]');
        if (progressEl) {
          const pText = (progressEl.innerText || '').trim();
          if (pText) await postJSON('/progress', { task_id, progress: 30, msg: `抖音：上传中 ${pText}` });
        }

        // 检测上传失败
        const bodyText = document.body.innerText || '';
        if (bodyText.includes('上传失败')) throw new Error('检测到"上传失败"提示');

        // 检测标题输入框/编辑器出现（上传完成的信号）
        const titleInput = document.querySelector(
          'input[placeholder*="标题"], input[placeholder*="作品标题"], [class*="title-input"] input, [class*="titleInput"] input'
        );
        const descEditor = document.querySelector(
          '[contenteditable="true"][class*="editor"], [contenteditable="true"][class*="desc"], .ql-editor, [class*="notranslate"][contenteditable="true"]'
        );
        if ((titleInput && titleInput.offsetParent) || (descEditor && descEditor.offsetParent)) {
          editorReady = true;
          await postJSON('/progress', { task_id, progress: 70, msg: '抖音：上传完成，填写信息' });
          break;
        }
      }

      if (!editorReady) throw new Error('等待上传完成超时（10分钟）');

      await sleep(2000);
      await dismissPopupsRounds(3, 600);

      // 4. 填写标题
      if (meta && meta.title) {
        const titleEl = document.querySelector(
          'input[placeholder*="标题"], input[placeholder*="作品标题"], [class*="title-input"] input, [class*="titleInput"] input'
        );
        if (titleEl) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(titleEl, meta.title);
          titleEl.dispatchEvent(new Event('input', { bubbles: true }));
          titleEl.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[Auto Upload] 抖音：标题已填写');
        }
      }
      await postJSON('/progress', { task_id, progress: 75, msg: '抖音：标题已填写' });

      // 5. 填写描述 + 话题
      const descEl = document.querySelector(
        '.editor-kit-container[contenteditable="true"], [contenteditable="true"][class*="editor"], [contenteditable="true"][class*="desc"], .ql-editor, [class*="notranslate"][contenteditable="true"]'
      );
      console.log('[Auto Upload] 抖音描述编辑器:', descEl ? descEl.className : '未找到', 'description:', meta?.description, 'tags:', meta?.tags);
      if (descEl && meta) {
        descEl.focus();
        await sleep(300);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        if (meta.description) {
          document.execCommand('insertText', false, meta.description);
          descEl.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(300);
        }

        // 插入话题标签
        if (meta.tags && meta.tags.length > 0) {
          if (meta.description) {
            document.execCommand('insertText', false, ' ');
            await sleep(200);
          }
          for (const tag of meta.tags) {
            document.execCommand('insertText', false, `#${tag}`);
            descEl.dispatchEvent(new Event('input', { bubbles: true }));

            // 等话题建议弹窗出现
            let topicPopup = null;
            for (let i = 0; i < 8; i++) {
              await sleep(300);
              topicPopup = document.querySelector(
                '[class*="topic-container"], [class*="topic-list"], [class*="mention-list"], [class*="hashtag"]'
              );
              if (topicPopup) break;
            }

            if (topicPopup) {
              const firstItem = topicPopup.querySelector('[class*="item"], [class*="option"], li');
              if (firstItem) {
                firstItem.click();
                await sleep(400);
              }
              descEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              descEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
              await sleep(300);
            } else {
              document.execCommand('insertText', false, ' ');
              await sleep(200);
            }
          }
        }
      }
      await postJSON('/progress', { task_id, progress: 80, msg: '抖音：描述已填写' });

      // 关闭残留话题弹窗
      await sleep(500);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(300);

      // 6. 上传封面（如果提供）
      if (meta && meta.cover_path) {
        await postJSON('/progress', { task_id, progress: 82, msg: '抖音：准备上传封面' });

        // Step 1: 用 CDP 真实点击封面区域（JS .click() 无法触发模态框）
        let coverArea = document.querySelector('[class*="coverControl"]') ||
                         document.querySelector('[class*="cover-Jg"]');
        if (!coverArea) {
          coverArea = Array.from(document.querySelectorAll('div')).find(
            el => el.childElementCount <= 3 && (el.textContent || '').includes('选择封面')
          );
        }
        if (coverArea) {
          coverArea.scrollIntoView({ block: 'center' });
          await sleep(500);

          // 给封面区域打标记，用 CDP 真实鼠标事件点击
          coverArea.setAttribute('data-auto-upload-target', 'cover-area');
          const clickResult = await chrome.runtime.sendMessage({
            type: 'cdpClick', selector: '[data-auto-upload-target="cover-area"]',
          });
          console.log('[Auto Upload] 抖音：封面区域 CDP 点击', clickResult?.ok ? '成功' : ('失败: ' + clickResult?.error));
          await sleep(2000);

          let coverUploaded = false;

          // Step 2: 等待封面编辑模态框出现（通过 semi-upload-drag-area 判断）
          let modal = null;
          for (let i = 0; i < 15; i++) {
            // 直接找全局的 semi-upload-drag-area，它出现就说明模态框已打开
            if (document.querySelector('.semi-upload-drag-area')) {
              modal = document.body; // 用 body 作为搜索范围
              break;
            }
            await sleep(500);
          }

          if (modal) {

            // 先点击"上传封面"标签激活上传面板
            const uploadTab = Array.from(document.querySelectorAll('div,span')).find(
              el => el.offsetParent && el.childElementCount === 0 && (el.textContent || '').trim() === '上传封面'
            );
            if (uploadTab) {
              uploadTab.click();
              await sleep(1000);
            }

            let uploadArea = document.querySelector('.semi-upload-drag-area');

            if (uploadArea) {
              // CDP 点击 semi-upload-drag-area 触发文件选择
              const uploadClickResult = await chrome.runtime.sendMessage({
                type: 'setFileViaChooser',
                filePath: meta.cover_path,
                clickSelector: '.semi-upload-drag-area',
              });

              if (uploadClickResult?.ok) {
                console.log('[Auto Upload] 抖音：封面文件已通过 FileChooser 注入');
                await sleep(3000);
                coverUploaded = true;
              } else {
                console.warn('[Auto Upload] 抖音：FileChooser 注入失败，尝试 setFileInput', uploadClickResult?.error);
                // Fallback: 直接注入 image file input
                const coverResult = await chrome.runtime.sendMessage({
                  type: 'setFileInput',
                  filePath: meta.cover_path,
                  selector: 'input[type="file"][accept*="image"]',
                });
                if (coverResult?.ok) {
                  console.log('[Auto Upload] 抖音：封面文件已通过 setFileInput 注入');
                  await sleep(3000);
                  coverUploaded = true;
                } else {
                  console.warn('[Auto Upload] 抖音封面文件注入失败:', coverResult?.error);
                }
              }

              // Step 4: 点击"完成"按钮（全局搜索，因为模态框不在 modal 变量内）
              if (coverUploaded) {
                await sleep(2000);
                const finishBtn = document.querySelector('button.semi-button-primary.secondary-zU1YLr')
                  || Array.from(document.querySelectorAll('button.semi-button-primary')).find(btn =>
                    btn.offsetParent && (btn.innerText || '').trim() === '完成'
                  )
                  || Array.from(document.querySelectorAll('button')).find(btn =>
                    btn.offsetParent && (btn.innerText || '').trim() === '完成'
                  );
                if (finishBtn) {
                  finishBtn.click();
                  await sleep(2000);
                  console.log('[Auto Upload] 抖音：封面完成按钮已点击');
                } else {
                  console.warn('[Auto Upload] 抖音：未找到完成按钮');
                }
              }
            } else {
              await postJSON('/progress', { task_id, progress: 83, msg: '抖音封面：模态框内未找到 semi-upload-drag-area' });
            }
          } else {
            await postJSON('/progress', { task_id, progress: 83, msg: '抖音封面：模态框未打开' });
          }

          await postJSON('/progress', { task_id, progress: 84, msg: coverUploaded ? '抖音：封面已上传' : '抖音：封面上传失败，已跳过' });
        } else {
          console.warn('[Auto Upload] 抖音：未找到封面区域');
        }
      }

      // 7. 定时发布
      if (meta && meta.publish_time) {
        await postJSON('/progress', { task_id, progress: 85, msg: '抖音：设置定时发布' });

        // 点击"定时发布"选项
        const scheduleRadio = Array.from(document.querySelectorAll('label, [class*="radio"], [role="radio"]')).find(
          el => (el.textContent || '').includes('定时发布')
        );
        if (scheduleRadio) {
          scheduleRadio.click();
          await sleep(1000);
        }

        // 填写时间
        const dtInput = document.querySelector(
          '[class*="date"] input, [class*="time"] input, input[placeholder*="选择"], input[placeholder*="时间"]'
        );
        if (dtInput) {
          const [datePart, timePart] = meta.publish_time.split(' ');
          const fullDateTime = `${datePart.replace(/\b(\d)\b/g, '0$1')} ${timePart.replace(/\b(\d)\b/g, '0$1')}`;
          dtInput.focus();
          await sleep(300);
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(dtInput, fullDateTime);
          dtInput.dispatchEvent(new Event('input', { bubbles: true }));
          dtInput.dispatchEvent(new Event('change', { bubbles: true }));
          dtInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          await sleep(500);
          dtInput.blur();
          await sleep(500);
        }

        await postJSON('/progress', { task_id, progress: 87, msg: `抖音：定时发布已设置 ${meta.publish_time}` });
      }

      // 8. 点击发布
      const isScheduled = !!(meta && meta.publish_time);
      const targetBtnText = isScheduled ? '定时发布' : '发布';
      let published = false;

      const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
      for (const btn of allBtns) {
        const text = (btn.innerText || btn.textContent || '').trim();
        if (text === targetBtnText || (text === '发布' && !isScheduled)) {
          btn.removeAttribute('disabled');
          btn.click();
          published = true;
          console.log(`[Auto Upload] 抖音：点击「${text}」按钮`);
          break;
        }
      }

      if (!published) {
        // fallback: 找包含"发布"文字的按钮（排除"高清发布"、"暂存离开"等）
        const excludeTexts = ['高清发布', '暂存离开', '重新上传'];
        for (const btn of allBtns) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (text.includes('发布') && !excludeTexts.some(ex => text.includes(ex))) {
            btn.removeAttribute('disabled');
            btn.click();
            published = true;
            console.log(`[Auto Upload] 抖音：fallback 点击「${text}」按钮`);
            break;
          }
        }
      }

      if (!published) {
        const btnTexts = allBtns.map(b => (b.innerText || '').trim()).filter(t => t);
        throw new Error(`未找到「${targetBtnText}」按钮，页面按钮: [${btnTexts.join(', ')}]`);
      }

      await postJSON('/progress', { task_id, progress: 90, msg: '抖音：已点击发布按钮，等待确认' });

      // 9. 等待发布完成确认
      const publishStart = Date.now();
      const publishTimeout = 60 * 1000;
      let publishConfirmed = false;
      const publishPageUrl = location.href;

      while (Date.now() - publishStart < publishTimeout) {
        await sleep(2000);

        // 优先检测成功信号（避免误判）
        // 检测页面跳转（发布成功后通常会跳转到内容管理页）
        if (location.href !== publishPageUrl) {
          publishConfirmed = true;
          console.log('[Auto Upload] 抖音：页面已跳转，发布成功', location.href);
          break;
        }

        // 检测成功提示文字
        const toastEls = Array.from(document.querySelectorAll(
          '[class*="toast"], [class*="semi-toast"], [class*="semi-notification"]'
        )).filter(el => el.offsetParent);
        for (const toast of toastEls) {
          const t = (toast.innerText || '').trim();
          if (t.includes('发布成功') || t.includes('作品已发布') || t.includes('定时发布成功')) {
            publishConfirmed = true;
            console.log('[Auto Upload] 抖音：检测到发布成功提示', t);
            break;
          }
        }
        if (publishConfirmed) break;

        // 检测发布错误提示
        for (const toast of toastEls) {
          const t = (toast.innerText || '').trim();
          if (t && (t.includes('失败') || t.includes('错误') || t.includes('异常'))) {
            throw new Error(`发布失败：${t}`);
          }
        }

        // 检测真正的验证弹窗（iframe 内嵌验证，非页面上的普通元素）
        const verifyIframe = Array.from(document.querySelectorAll('iframe')).find(
          f => f.src && (f.src.includes('verify') || f.src.includes('captcha'))
        );
        if (verifyIframe) {
          throw new Error('发布被拦截：检测到验证弹窗(iframe)，需要手动完成验证');
        }
      }

      if (!publishConfirmed) {
        // 超时后再检查一次是否跳转了
        if (location.href !== publishPageUrl) {
          publishConfirmed = true;
        } else {
          throw new Error('发布超时：点击发布按钮后60秒内未确认成功，可能需要手动检查');
        }
      }

      const postUrl = location.href;
      navigator.sendBeacon(BASE_URL + '/done', JSON.stringify({ task_id, post_url: postUrl }));
      console.log('[Auto Upload] 抖音任务完成', task_id);

      // 发布成功后关闭标签页
      await sleep(2000);
      chrome.runtime.sendMessage({ type: 'closeTab' });

    } catch (e) {
      console.error('[Auto Upload] 抖音任务失败', task_id, e);
      navigator.sendBeacon(BASE_URL + '/fail', JSON.stringify({ task_id, error: e.message || String(e) }));
    }
  }

  // -------------------------------------------------------------------------
  // 轮询循环
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 小红书 — 内容管理
  // -------------------------------------------------------------------------

  async function xhsListPosts(taskId, meta) {
    // 等待笔记列表 DOM 加载
    for (let i = 0; i < 30; i++) {
      if (document.querySelectorAll('.note').length > 0) break;
      await sleep(1000);
    }
    await sleep(1000);

    // 滚动加载全部笔记（滚动容器是 .content）
    const scrollContainer = document.querySelector('.content') || document.documentElement;
    let prevCount = 0;
    let stableRounds = 0;
    for (let i = 0; i < 100; i++) {
      const currentCount = document.querySelectorAll('.note').length;
      if (currentCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
        prevCount = currentCount;
      }
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await sleep(1000);
    }
    scrollContainer.scrollTop = 0;
    await sleep(500);

    const statusFilter = meta.status_filter || '';
    const posts = [];
    const rows = document.querySelectorAll('.note');
    console.log(`[Auto Upload] 小红书列表：共加载 ${rows.length} 条记录`);

    for (const row of rows) {
      // noteId 从 data-impression JSON 中提取
      let postId = '';
      try {
        const imp = JSON.parse(row.getAttribute('data-impression') || '{}');
        postId = imp.noteTarget?.value?.noteId || '';
      } catch (e) {}

      const titleEl = row.querySelector('.info .title');
      const statusEl = row.querySelector('.info .raw span');
      const timeEl = row.querySelector('.info .time_status .time');
      const coverEl = row.querySelector('.media-bg');

      const statusText = statusEl ? statusEl.textContent.trim() : '';
      const timeText = timeEl ? timeEl.textContent.trim() : '';
      const scheduleEl = row.querySelector('.info .time_status .schedule');

      // 推断发布状态
      let pubStatus = 'published';
      if (statusText.includes('审核')) pubStatus = '审核中';
      else if (scheduleEl) pubStatus = 'scheduled';

      // 状态过滤
      if (statusFilter) {
        if (statusFilter === 'published' && pubStatus !== 'published') continue;
        if (statusFilter === 'scheduled' && pubStatus !== 'scheduled') continue;
        if (statusFilter === '审核中' && pubStatus !== '审核中') continue;
      }

      let coverUrl = '';
      if (coverEl) {
        const bg = coverEl.style.backgroundImage || '';
        const m = bg.match(/url\("?(.+?)"?\)/);
        if (m) coverUrl = m[1];
      }

      posts.push({
        post_id: postId,
        title: titleEl ? titleEl.textContent.trim() : '',
        status: pubStatus,
        status_text: statusText,
        publish_time: timeText,
        cover_url: coverUrl,
      });
    }

    return { status: 'ok', posts };
  }

  async function xhsEditPost(taskId, meta) {
    // 等待笔记列表加载
    for (let i = 0; i < 30; i++) {
      if (document.querySelectorAll('.note').length > 0) break;
      await sleep(1000);
    }
    await sleep(1000);

    const postId = meta.post_id;
    if (!postId) return { status: 'error', error: '缺少 post_id' };

    const row = xhsFindNoteByPostId(postId);
    if (!row) return { status: 'error', error: `找不到 noteId=${postId} 的笔记` };

    // 点击编辑按钮
    const editBtn = row.querySelector('.data-edit');
    if (!editBtn) return { status: 'error', error: '找不到编辑按钮' };
    editBtn.click();

    // 等待编辑区域加载（TipTap/ProseMirror 编辑器）
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (document.querySelector('input.d-text') || document.querySelector('.tiptap.ProseMirror')) break;
    }
    await sleep(1000);

    const editMeta = meta.meta || {};

    // 修改标题
    if (editMeta.title !== undefined) {
      const titleEl = document.querySelector('input.d-text[type="text"]');
      if (titleEl) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(titleEl, editMeta.title);
        titleEl.dispatchEvent(new Event('input', { bubbles: true }));
        titleEl.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Auto Upload] 编辑：标题已修改');
      }
    }

    // 修改描述 + 标签（TipTap ProseMirror 编辑器）
    if (editMeta.description !== undefined || (editMeta.tags && editMeta.tags.length > 0)) {
      const descEl = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
      if (descEl) {
        descEl.focus();
        await sleep(300);
        // 清空原有内容
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(200);

        // 插入描述
        if (editMeta.description) {
          document.execCommand('insertText', false, editMeta.description);
          descEl.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(300);
        }

        // 插入标签
        if (editMeta.tags && editMeta.tags.length > 0) {
          if (editMeta.description) {
            document.execCommand('insertText', false, ' ');
            await sleep(200);
          }
          for (const tag of editMeta.tags) {
            document.execCommand('insertText', false, `#${tag}`);
            descEl.dispatchEvent(new Event('input', { bubbles: true }));
            // 等话题建议弹窗
            let topicPopup = null;
            for (let i = 0; i < 8; i++) {
              await sleep(250);
              topicPopup = document.querySelector('[class*="topic-container"], [class*="topic-list"]');
              if (topicPopup) break;
            }
            if (topicPopup) {
              const firstItem = topicPopup.querySelector('[class*="item"]');
              if (firstItem) {
                firstItem.click();
                await sleep(400);
              }
              descEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              descEl.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
              await sleep(300);
            } else {
              document.execCommand('insertText', false, ' ');
              await sleep(200);
            }
          }
        }
        console.log('[Auto Upload] 编辑：描述/标签已修改');
      }
    }

    // 重新上传视频
    if (editMeta.video_path) {
      const reuploadBtn = document.querySelector('.video-plugin-title-action');
      if (reuploadBtn) {
        console.log('[Auto Upload] 编辑：重新上传视频');
        const result = await chrome.runtime.sendMessage({
          type: 'setFileViaChooser',
          filePath: editMeta.video_path,
          clickSelector: '.video-plugin-title-action',
        });
        console.log('[Auto Upload] 编辑：视频上传结果', result);
        // 等待视频上传完成（发布按钮从 disabled 变为可用）
        for (let i = 0; i < 300; i++) {
          await sleep(2000);
          const btn = document.querySelector('.publish-page-publish-btn button');
          if (btn && !btn.disabled && !btn.classList.contains('disabled')) {
            console.log('[Auto Upload] 编辑：视频上传完成，按钮可用');
            break;
          }
        }
        await sleep(2000);
      }
    }

    // 定时发布设置
    if (editMeta.publish_time !== undefined) {
      // 辅助：scrollIntoView 后 CDP 点击
      async function cdpClickEl(el) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(200);
        const tid = '__xhs_edit_' + Date.now();
        el.id = tid;
        await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${tid}` });
        el.id = '';
        await sleep(400);
      }

      let scheduleSwitch = null;
      for (let i = 0; i < 10; i++) {
        scheduleSwitch = document.querySelector('.custom-switch-card .d-switch-simulator');
        if (scheduleSwitch) break;
        await sleep(500);
      }

      if (editMeta.publish_time === '' || editMeta.publish_time === null) {
        // 取消定时发布（关闭开关）
        if (scheduleSwitch && !scheduleSwitch.classList.contains('unchecked')) {
          scheduleSwitch.scrollIntoView({ block: 'center' });
          await sleep(300);
          scheduleSwitch.click();
          await sleep(500);
          console.log('[Auto Upload] 编辑：已取消定时发布');
        }
      } else {
        // 设置定时发布
        const [datePart, timePart] = editMeta.publish_time.split(' ');
        const [, , targetDay] = datePart.split('-');
        const [targetHour, targetMin] = timePart.split(':');
        const targetDayNum = String(parseInt(targetDay, 10));

        // 打开定时开关
        const isUnchecked = scheduleSwitch?.classList.contains('unchecked');
        if (scheduleSwitch && isUnchecked) {
          scheduleSwitch.scrollIntoView({ block: 'center' });
          await sleep(600);
          scheduleSwitch.click();
          await sleep(1500);
        }

        // 点击日期输入框打开弹窗
        let dtInput = null;
        for (let i = 0; i < 8; i++) {
          dtInput = document.querySelector('.d-datepicker input');
          if (dtInput) break;
          await sleep(500);
        }
        if (dtInput) {
          await cdpClickEl(dtInput);
          await sleep(800);

          let popover = null;
          for (let i = 0; i < 10; i++) {
            popover = document.querySelector('.post-time-date-picker-popover-class');
            if (popover) break;
            await sleep(300);
          }
          if (popover) {
            // 选日期
            const dayCells = Array.from(popover.querySelectorAll('.d-datepicker-cell.d-clickable:not(.disabled)'));
            const dayCell = dayCells.find(c =>
              (c.querySelector('span.d-text-monospace') || c.querySelector('span') || c).textContent.trim() === targetDayNum
            );
            if (dayCell) { await cdpClickEl(dayCell); await sleep(600); }

            // 选小时 + 分钟
            const timeBars = Array.from(popover.querySelectorAll('.d-timepicker-timebar'));
            async function clickTimeItem(bar, target) {
              const item = Array.from(bar.querySelectorAll('.d-timepicker-time')).find(el =>
                (el.querySelector('span.d-text-monospace') || el.querySelector('span') || el).textContent.trim() === target
              );
              if (item) { await cdpClickEl(item); }
            }
            if (timeBars[0]) await clickTimeItem(timeBars[0], targetHour);
            if (timeBars[1]) await clickTimeItem(timeBars[1], targetMin);
          }
        }
        console.log('[Auto Upload] 编辑：定时发布已设置', editMeta.publish_time);
        await sleep(500);
      }
    }

    // 点击编辑器外部收起弹窗
    await sleep(500);
    document.body.click();
    await sleep(500);

    // 点击发布/保存按钮
    const isScheduled = !!(editMeta.publish_time && editMeta.publish_time !== '');
    const editTargetText = isScheduled ? '定时发布' : '发布';
    let editPublished = false;

    const editBtnSpans = document.querySelectorAll('.d-button-content span');
    for (const span of editBtnSpans) {
      const text = (span.textContent || '').trim();
      if (text === editTargetText) {
        const btn = span.closest('button');
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          await sleep(500);
          btn.removeAttribute('disabled');
          btn.click();
          editPublished = true;
          console.log(`[Auto Upload] 编辑：已点击「${editTargetText}」按钮`);
          await sleep(2000);
          break;
        }
      }
    }

    if (!editPublished) {
      console.warn(`[Auto Upload] 编辑：未找到「${editTargetText}」按钮`);
    }

    return { status: 'ok' };
  }

  async function xhsScrollLoadAll() {
    // 等待初始笔记出现
    for (let i = 0; i < 30; i++) {
      if (document.querySelectorAll('.note').length > 0) break;
      await sleep(1000);
    }
    await sleep(1000);
    // 滚动直到全部加载
    const scrollContainer = document.querySelector('.content') || document.documentElement;
    let prevCount = 0, stableRounds = 0;
    for (let i = 0; i < 100; i++) {
      const currentCount = document.querySelectorAll('.note').length;
      if (currentCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
        prevCount = currentCount;
      }
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await sleep(1000);
    }
    scrollContainer.scrollTop = 0;
    await sleep(500);
  }

  async function xhsDeletePost(taskId, meta) {
    await xhsScrollLoadAll();

    const postId = meta.post_id;
    if (!postId) return { status: 'error', error: '缺少 post_id' };

    const row = xhsFindNoteByPostId(postId);
    if (!row) return { status: 'error', error: `找不到 noteId=${postId} 的笔记` };

    // 点击删除按钮
    const delBtn = row.querySelector('.data-del');
    if (!delBtn) return { status: 'error', error: '找不到删除按钮' };
    delBtn.click();
    await sleep(1000);

    // 确认删除弹窗 — 点击确认按钮
    const confirmBtns = document.querySelectorAll('.d-dialog button, .d-modal button, [class*="dialog"] button, [class*="modal"] button');
    for (const btn of confirmBtns) {
      const text = (btn.textContent || '').trim();
      if (text === '确认' || text === '确定' || text === '删除') {
        btn.click();
        await sleep(1000);
        return { status: 'ok' };
      }
    }

    return { status: 'error', error: '未找到删除确认按钮' };
  }

  function xhsFindNoteByPostId(postId) {
    const rows = document.querySelectorAll('.note');
    for (const row of rows) {
      try {
        const imp = JSON.parse(row.getAttribute('data-impression') || '{}');
        if (imp.noteTarget?.value?.noteId === postId) return row;
      } catch (e) {}
    }
    return null;
  }

  async function xhsDeleteAllPosts(taskId, meta) {
    // 滚动加载全部笔记
    await xhsScrollLoadAll();

    let deleted = 0, failed = 0;

    // 反复删除直到没有笔记为止（每次删后页面会减少一条）
    while (true) {
      const rows = document.querySelectorAll('.note');
      if (rows.length === 0) break;

      const row = rows[0];
      const delBtn = row.querySelector('.data-del');
      if (!delBtn) {
        // 该行没有删除按钮（可能是审核中），跳过
        failed++;
        if (failed > rows.length) break;  // 防止死循环
        continue;
      }

      delBtn.click();
      await sleep(800);

      // 确认弹窗
      const confirmBtns = document.querySelectorAll('.d-dialog button, .d-modal button, [class*="dialog"] button, [class*="modal"] button');
      let confirmed = false;
      for (const btn of confirmBtns) {
        const text = (btn.textContent || '').trim();
        if (text === '确认' || text === '确定' || text === '删除') {
          btn.click();
          confirmed = true;
          deleted++;
          await sleep(1200);
          break;
        }
      }

      if (!confirmed) {
        // 关掉弹窗（ESC 或点取消）
        const cancelBtns = document.querySelectorAll('.d-dialog button, .d-modal button, [class*="dialog"] button, [class*="modal"] button');
        for (const btn of cancelBtns) {
          const text = (btn.textContent || '').trim();
          if (text === '取消' || text === '关闭') { btn.click(); break; }
        }
        failed++;
        await sleep(500);
      }
    }

    return { status: 'ok', deleted, failed };
  }

  // 小红书：按 post_id 列表批量删除，全部删完后关标签
  async function xhsDeleteBatch(taskId, meta) {
    const postIds = meta.post_ids || [];
    if (!postIds.length) return { status: 'error', error: '缺少 post_ids' };

    // 滚动加载全部笔记
    await xhsScrollLoadAll();

    let deleted = 0, failed = 0, notFound = 0;

    for (const postId of postIds) {
      // 每次删除后 DOM 会更新，重新查找
      const row = xhsFindNoteByPostId(postId);
      if (!row) { notFound++; continue; }

      const delBtn = row.querySelector('.data-del');
      if (!delBtn) { failed++; continue; }

      delBtn.click();
      await sleep(800);

      const confirmBtns = document.querySelectorAll('.d-dialog button, .d-modal button, [class*="dialog"] button, [class*="modal"] button');
      let confirmed = false;
      for (const btn of confirmBtns) {
        const text = (btn.textContent || '').trim();
        if (text === '确认' || text === '确定' || text === '删除') {
          btn.click();
          confirmed = true;
          deleted++;
          await sleep(1200);
          break;
        }
      }
      if (!confirmed) {
        // 关掉弹窗
        const cancelBtns = document.querySelectorAll('.d-dialog button, .d-modal button, [class*="dialog"] button, [class*="modal"] button');
        for (const btn of cancelBtns) {
          const text = (btn.textContent || '').trim();
          if (text === '取消' || text === '关闭') { btn.click(); break; }
        }
        failed++;
        await sleep(500);
      }
    }

    return { status: 'ok', deleted, failed, not_found: notFound };
  }

  // -------------------------------------------------------------------------
  // 视频号 — 内容管理
  // -------------------------------------------------------------------------

  async function channelsRunInIframe(expression) {
    // 通过 runInPage 在页面上下文中访问 iframe DOM
    const result = await chrome.runtime.sendMessage({
      type: 'runInPage',
      expression: `(function() {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument;
            if (!doc) continue;
            if (doc.querySelectorAll('.post-feed-item').length > 0) {
              return (function(doc, iframe) { ${expression} })(doc, iframe);
            }
          } catch(e) {}
        }
        return null;
      })()`
    });
    return result?.result;
  }

  async function channelsListPosts(taskId, meta) {
    // 等待列表 DOM 加载（通过 runInPage 在页面上下文中查询 iframe）
    let itemCount = 0;
    for (let i = 0; i < 60; i++) {
      const count = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;');
      console.log(`[Auto Upload] 视频号列表等待中... postItems=${count}`);
      if (count && count > 0) { itemCount = count; break; }
      await sleep(1000);
    }
    if (!itemCount) return { status: 'error', error: '视频号列表未加载（60s超时）' };
    await sleep(1000);

    // 逐页采集所有数据
    const statusFilter = meta.status_filter || '';
    let allPosts = [];
    let globalIndex = 0;

    for (let page = 0; page < 50; page++) {  // 最多 50 页
      // 解析当前页
      const postsData = await channelsRunInIframe(`
        const rows = doc.querySelectorAll('.post-feed-item');
        const posts = [];
        const statusFilter = ${JSON.stringify(statusFilter)};
        const globalOffset = ${globalIndex};
        rows.forEach(function(row, index) {
          const titleEl = row.querySelector('.post-title');
          const postedTimeEl = row.querySelector('.posted-info .post-time span');
          const scheduledTimeEl = row.querySelector('.unposted-info .effective-time');
          const isScheduled = !!scheduledTimeEl;
          const pubStatus = isScheduled ? 'scheduled' : 'published';
          if (statusFilter) {
            if (statusFilter === 'published' && pubStatus !== 'published') return;
            if (statusFilter === 'scheduled' && pubStatus !== 'scheduled') return;
          }
          const timeText = scheduledTimeEl ? scheduledTimeEl.textContent.trim()
                         : postedTimeEl ? postedTimeEl.textContent.trim() : '';
          const stats = {};
          const statNames = ['views', 'likes', 'comments', 'shares', 'favorites'];
          row.querySelectorAll('.post-data .data-item .count').forEach(function(el, i) {
            if (statNames[i]) stats[statNames[i]] = parseInt(el.textContent.trim(), 10) || 0;
          });
          const canEdit = !!row.querySelector('use[*|href="#icon-edit_feed"]');
          const coverEl = row.querySelector('.thumb');
          posts.push({
            post_id: String(globalOffset + index),
            title: titleEl ? titleEl.textContent.trim() : '',
            status: pubStatus,
            publish_time: timeText,
            cover_url: coverEl ? coverEl.src : '',
            can_edit: canEdit,
            views: stats.views || 0,
            likes: stats.likes || 0,
            comments: stats.comments || 0,
            shares: stats.shares || 0,
            favorites: stats.favorites || 0,
          });
        });
        return { posts: posts, total: rows.length };
      `);

      if (postsData && postsData.posts) {
        allPosts = allPosts.concat(postsData.posts);
        globalIndex += postsData.total || 0;
      }

      // 检查是否有下一页按钮
      const hasNext = await channelsRunInIframe(`
        const nextBtn = doc.querySelector('.weui-desktop-pagination a');
        if (nextBtn && nextBtn.textContent.trim() === '下一页') {
          nextBtn.click();
          return true;
        }
        return false;
      `);

      if (!hasNext) break;

      // 等待新页面加载
      await sleep(2000);
      // 等待列表刷新
      for (let i = 0; i < 15; i++) {
        const count = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;');
        if (count && count > 0) break;
        await sleep(500);
      }
      await sleep(500);
    }

    console.log(`[Auto Upload] 视频号列表：共加载 ${allPosts.length} 条记录`);
    return { status: 'ok', posts: allPosts };
  }

  async function channelsNavigateToPage(targetIndex) {
    // 等待列表加载
    for (let i = 0; i < 30; i++) {
      const count = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;');
      if (count && count > 0) break;
      await sleep(1000);
    }
    await sleep(1000);

    // 获取每页条数
    const pageSize = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;') || 20;
    const targetPage = Math.floor(targetIndex / pageSize);  // 0-based
    const indexInPage = targetIndex % pageSize;

    // 翻到目标页
    for (let p = 0; p < targetPage; p++) {
      const clicked = await channelsRunInIframe(`
        const links = doc.querySelectorAll('.weui-desktop-pagination a');
        for (const a of links) {
          if (a.textContent.trim() === '下一页') { a.click(); return true; }
        }
        return false;
      `);
      if (!clicked) break;
      await sleep(2000);
      // 等新页面加载
      for (let i = 0; i < 15; i++) {
        const c = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;');
        if (c && c > 0) break;
        await sleep(500);
      }
      await sleep(500);
    }

    return indexInPage;
  }

  async function channelsEditPost(taskId, meta) {
    const postIndex = parseInt(meta.post_id, 10);
    if (isNaN(postIndex)) return { status: 'error', error: '缺少 post_id (index)' };

    const indexInPage = await channelsNavigateToPage(postIndex);

    // 在 iframe 中点击编辑按钮（强制显示 + 直接 click）
    const clickResult = await channelsRunInIframe(`
      const rows = doc.querySelectorAll('.post-feed-item');
      if (${indexInPage} >= rows.length) return { error: '索引超出范围' };
      const row = rows[${indexInPage}];
      const editIcon = row.querySelector('use[*|href="#icon-edit_feed"]');
      if (!editIcon) return { error: '该内容不支持编辑（已发布内容无法修改）' };
      const opr = row.querySelector('.opr');
      if (opr) opr.style.cssText = 'opacity:1 !important; visibility:visible !important; display:flex !important;';
      row.querySelectorAll('.opr-item-wrap').forEach(function(el) {
        el.style.cssText = 'opacity:1 !important; visibility:visible !important; display:flex !important;';
      });
      const editBtn = editIcon.closest('.opr-item') || editIcon.closest('.opr-item-wrap');
      editBtn.click();
      return { ok: true };
    `);
    if (clickResult?.error) return { status: 'error', error: clickResult.error };

    // 等待编辑页加载（SPA 内部导航，JS 上下文不变）
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const found = await runInPage(`
        (function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              if (doc && doc.querySelector('.post-desc-box .input-editor')) return true;
            } catch(e) {}
          }
          return false;
        })()
      `);
      if (found?.result === true) break;
    }
    await sleep(2000);

    const editMeta = meta.meta || {};

    // 填写标题/描述/标签
    if (editMeta.title !== undefined || editMeta.description !== undefined || (editMeta.tags && editMeta.tags.length > 0)) {
      const fillResult = await runInPage(`
        (function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              if (!doc) continue;
              var editor = doc.querySelector('.post-desc-box .input-editor');
              if (!editor) continue;
              ${editMeta.title !== undefined ? `
              editor.innerHTML = '';
              editor.focus();
              document.execCommand('insertText', false, ${JSON.stringify(editMeta.title || '')});
              ` : ''}
              ${editMeta.description !== undefined ? `
              document.execCommand('insertText', false, '\\n' + ${JSON.stringify(editMeta.description || '')});
              ` : ''}
              ${editMeta.tags && editMeta.tags.length > 0 ? `
              var tags = ${JSON.stringify(editMeta.tags)};
              for (var t = 0; t < tags.length; t++) {
                document.execCommand('insertText', false, ' #' + tags[t]);
              }
              ` : ''}
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true };
            } catch(e) {}
          }
          return { ok: false };
        })()
      `);
      console.log('[Auto Upload] 视频号编辑：填写结果', fillResult);
      await sleep(1000);
    }

    // 封面修改
    if (editMeta.cover_path) {
      console.log('[Auto Upload] 视频号编辑：开始修改封面');

      // 封面上传通用函数（带重试）
      async function channelsEditUploadCover(editBtnSelector, label, maxRetries) {
        for (let retry = 0; retry < maxRetries; retry++) {
          if (retry > 0) console.log(`[Auto Upload] ${label}封面重试第 ${retry} 次`);

          // 滚动编辑按钮到可视区域
          await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var el = iframes[i].contentDocument.querySelector(${JSON.stringify(editBtnSelector)});
                if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
              } catch(e) {}
            }
          })()`);
          await sleep(1000);

          // 点击编辑按钮
          const editResult = await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: editBtnSelector });
          console.log(`[Auto Upload] ${label}编辑按钮:`, JSON.stringify(editResult));
          if (!editResult?.ok) {
            await sleep(3000);
            continue;
          }
          await sleep(2000);

          // 等待弹窗打开并查找 .add-icon
          let addIconFound = false;
          let dialogOpen = false;
          for (let i = 0; i < 10; i++) {
            await sleep(1000);
            const check = await runInPage(`
              (function() {
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                  try {
                    var doc = iframes[i].contentDocument;
                    var dialog = doc.querySelector('.cover-set-footer');
                    if (!dialog) continue;
                    var els = doc.querySelectorAll('.add-icon');
                    for (var j = 0; j < els.length; j++) {
                      var r = els[j].getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) return { found: true };
                    }
                    return { found: false, dialogOpen: true };
                  } catch(e) {}
                }
                return { found: false };
              })()
            `);
            if (check?.result?.found) { addIconFound = true; break; }
            if (check?.result?.dialogOpen) { dialogOpen = true; break; }
          }

          // 弹窗已打开但 .add-icon 不可见 → 需要先点击「上传封面」切换到上传模式
          if (!addIconFound && dialogOpen) {
            console.log(`[Auto Upload] ${label} 弹窗已打开但无 .add-icon，点击「上传封面」`);
            await runInPage(`(function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var doc = iframes[i].contentDocument;
                  var wraps = doc.querySelectorAll('.text-wrap');
                  for (var j = 0; j < wraps.length; j++) {
                    if (wraps[j].textContent.trim() === '上传封面') {
                      var clickTarget = wraps[j].closest('.wrap') || wraps[j];
                      clickTarget.click();
                      return;
                    }
                  }
                } catch(e) {}
              }
            })()`);
            await sleep(2000);

            // 再次等待 .add-icon 出现
            for (let i = 0; i < 10; i++) {
              await sleep(1000);
              const check = await runInPage(`
                (function() {
                  var iframes = document.querySelectorAll('iframe');
                  for (var i = 0; i < iframes.length; i++) {
                    try {
                      var els = iframes[i].contentDocument.querySelectorAll('.add-icon');
                      for (var j = 0; j < els.length; j++) {
                        var r = els[j].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return true;
                      }
                    } catch(e) {}
                  }
                  return false;
                })()
              `);
              if (check?.result === true) { addIconFound = true; break; }
            }
          }

          if (!addIconFound) {
            // 关闭可能的弹窗再重试
            await runInPage(`(function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var btn = iframes[i].contentDocument.querySelector('.cover-set-footer .weui-desktop-btn_default');
                  if (btn) btn.click();
                } catch(e) {}
              }
            })()`);
            await sleep(2000);
            continue;
          }

          // 上传封面文件（点击 .initial-wrap 即「上传封面」可点击区域）
          const coverResult = await chrome.runtime.sendMessage({
            type: 'setFileViaChooser', filePath: editMeta.cover_path, clickSelector: '.initial-wrap',
          });
          if (!coverResult?.ok) {
            console.warn(`[Auto Upload] ${label}封面上传失败:`, coverResult?.error);
            await sleep(2000);
            continue;
          }
          console.log(`[Auto Upload] ${label}封面上传成功`);
          await sleep(3000);

          // 点击确认
          await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btn = iframes[i].contentDocument.querySelector('.cover-set-footer .weui-desktop-btn_primary');
                if (btn) { btn.click(); return; }
              } catch(e) {}
            }
          })()`);
          await sleep(2000);
          return true;
        }
        console.warn(`[Auto Upload] ${label}封面修改失败（已重试 ${maxRetries} 次）`);
        return false;
      }

      // 等待视频预览图完全加载（.edit-btn 可见）
      let editBtnReady = false;
      for (let i = 0; i < 60; i++) {
        const found = await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btn = iframes[i].contentDocument.querySelector('.vertical-img-wrap .edit-btn');
                if (btn && btn.offsetParent) return true;
              } catch(e) {}
            }
            return false;
          })()
        `);
        if (found?.result === true) { editBtnReady = true; break; }
        if (i % 10 === 0) console.log(`[Auto Upload] 等待封面预览图加载... (${i * 2}s)`);
        await sleep(2000);
      }
      if (editBtnReady) {
        // 滚动封面区域到可视区域，确保 CDP 鼠标事件能命中
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var el = iframes[i].contentDocument.querySelector('.vertical-img-wrap .edit-btn');
              if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
            } catch(e) {}
          }
        })()`);
        await sleep(15000); // 等待页面稳定

        // 个人卡片封面（最多重试 3 次）
        await channelsEditUploadCover('.vertical-img-wrap .edit-btn', '个人卡片', 3);

        // 分享卡片封面（横屏视频才有）
        const hasHorizon = await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var el = iframes[i].contentDocument.querySelector('.horizon-img-wrap .edit-btn');
                if (el && el.offsetParent) return true;
              } catch(e) {}
            }
            return false;
          })()
        `);
        if (hasHorizon?.result === true) {
          console.log('[Auto Upload] 视频号编辑：处理分享卡片封面');

          // Step 1: 滚动并点击分享卡片编辑按钮
          await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var el = iframes[i].contentDocument.querySelector('.horizon-img-wrap .edit-btn');
                if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
              } catch(e) {}
            }
          })()`);
          await sleep(1000);
          await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.horizon-img-wrap .edit-btn' });
          await sleep(2000);

          // Step 2: 点击 .cover-tips（切换到分享卡片模式）
          await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.cover-tips' });
          await sleep(1500);

          // Step 3: 点击「使用素材」按钮
          await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btns = iframes[i].contentDocument.querySelectorAll('.weui-desktop-btn_primary');
                for (var j = 0; j < btns.length; j++) {
                  if (btns[j].textContent.trim() === '使用素材') { btns[j].click(); return; }
                }
              } catch(e) {}
            }
          })()`);
          await sleep(2000);

          // Step 4: 在裁剪器中拖动图片到顶部
          const dragResult = await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var vp = iframes[i].contentDocument.querySelector('.cr-viewport');
                if (!vp) continue;
                var img = iframes[i].contentDocument.querySelector('.cr-image');
                if (!img) continue;
                var vpRect = vp.getBoundingClientRect();
                var imgRect = img.getBoundingClientRect();
                var frRect = iframes[i].getBoundingClientRect();
                return {
                  found: true,
                  vpCx: frRect.left + vpRect.left + vpRect.width / 2,
                  vpCy: frRect.top + vpRect.top + vpRect.height / 2,
                  dragY: vpRect.top - imgRect.top
                };
              } catch(e) {}
            }
            return { found: false };
          })()`);
          console.log('[Auto Upload] 分享卡片裁剪器:', JSON.stringify(dragResult));

          if (dragResult?.result?.found && dragResult.result.dragY > 0) {
            const { vpCx, vpCy, dragY } = dragResult.result;
            await chrome.runtime.sendMessage({
              type: 'cdpDrag',
              startX: vpCx, startY: vpCy,
              endX: vpCx, endY: vpCy + dragY,
            });
            await sleep(1000);
          }

          // Step 5: 点击确认
          await runInPage(`(function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btns = iframes[i].contentDocument.querySelectorAll('.weui-desktop-btn_primary');
                for (var j = btns.length - 1; j >= 0; j--) {
                  if (btns[j].offsetParent && btns[j].textContent.trim().match(/确认|完成|保存/)) {
                    btns[j].click(); return;
                  }
                }
              } catch(e) {}
            }
          })()`);
          await sleep(2000);
        }
      } else {
        console.warn('[Auto Upload] 视频号编辑：等待封面预览图超时，跳过封面修改');
      }
      console.log('[Auto Upload] 视频号编辑：封面修改完成');
    }

    // 定时发布设置
    if (editMeta.publish_time !== undefined) {
      // 滚动定时发布区域到可视范围
      await runInPage(`(function() {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var el = iframes[i].contentDocument.querySelector('.weui-desktop-form__radio[value="1"]');
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
          } catch(e) {}
        }
      })()`);
      await sleep(1000);

      if (editMeta.publish_time === '' || editMeta.publish_time === null) {
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var r = iframes[i].contentDocument.querySelector('.weui-desktop-form__radio[value="0"]');
              if (r) { r.click(); return; }
            } catch(e) {}
          }
        })()`);
        console.log('[Auto Upload] 视频号编辑：已取消定时发布');
        await sleep(500);
      } else {
        const [datePart, timePart] = editMeta.publish_time.split(' ');
        const [, , targetDay] = datePart.split('-');
        const [targetHour, targetMin] = timePart.split(':');
        const dayNum = String(parseInt(targetDay, 10));
        const hourStr = String(parseInt(targetHour, 10)).padStart(2, '0');
        const minStr = String(parseInt(targetMin, 10)).padStart(2, '0');
        const editTargetMonth = String(parseInt(datePart.split('-')[1], 10));
        console.log(`[Auto Upload] 视频号编辑：定时发布解析 原始值="${editMeta.publish_time}" 月=${editTargetMonth} 日=${dayNum} 时=${hourStr} 分=${minStr}`);

        // 点击"定时发布"单选按钮
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var r = iframes[i].contentDocument.querySelector('.weui-desktop-form__radio[value="1"]');
              if (r) { r.click(); return; }
            } catch(e) {}
          }
        })()`);
        await sleep(1000);

        // 点击日期输入框打开日期选择器
        await chrome.runtime.sendMessage({
          type: 'cdpClickIframe',
          selector: '.weui-desktop-form__input[placeholder="请选择发表时间"]',
        });
        await sleep(1000);

        // 选择日期（支持跨月）
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
              if (!links.length) continue;

              // 检查当前显示的月份是否匹配目标月份
              var monthEl = doc.querySelector('.weui-desktop-picker__panel_month .weui-desktop-picker__selected');
              var curMonth = monthEl ? String(parseInt(monthEl.textContent, 10)) : '';
              if (curMonth && curMonth !== ${JSON.stringify(editTargetMonth)}) {
                var nextBtn = doc.querySelector('.weui-desktop-picker__panel_day .weui-desktop-picker__arrow_right') ||
                              doc.querySelector('.weui-desktop-picker__arrow:last-child');
                if (nextBtn) nextBtn.click();
                // 延迟选择日期（等 UI 更新）
                setTimeout(function() {
                  var newLinks = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
                  for (var j = 0; j < newLinks.length; j++) {
                    var a = newLinks[j];
                    if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
                    if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); return; }
                  }
                }, 300);
                return;
              }

              for (var j = 0; j < links.length; j++) {
                var a = links[j];
                if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
                if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); return; }
              }
            } catch(e) {}
          }
        })()`);
        await sleep(800);

        // 点击时间区域展开时间面板
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-picker__dt' });
        await sleep(1000);

        // 选择小时（滚动式选择器，通过滚动 ol 到目标位置实现选中）
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              var ol = doc.querySelector('.weui-desktop-picker__time__hour');
              if (!ol) continue;
              var items = ol.querySelectorAll('li');
              for (var j = 0; j < items.length; j++) {
                if (items[j].textContent.trim() === ${JSON.stringify(hourStr)}) {
                  var liH = items[j].offsetHeight;
                  ol.scrollTop = j * liH;
                  ol.dispatchEvent(new Event('scroll', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return;
                }
              }
            } catch(e) {}
          }
        })()`);
        await sleep(500);

        // 选择分钟
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              var ol = doc.querySelector('.weui-desktop-picker__time__minute');
              if (!ol) continue;
              var items = ol.querySelectorAll('li');
              for (var j = 0; j < items.length; j++) {
                if (items[j].textContent.trim() === ${JSON.stringify(minStr)}) {
                  var liH = items[j].offsetHeight;
                  ol.scrollTop = j * liH;
                  ol.dispatchEvent(new Event('scroll', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  items[j].dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  return;
                }
              }
            } catch(e) {}
          }
        })()`);
        await sleep(500);

        // 点击空白处关闭时间选择器
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var body = iframes[i].contentDocument.querySelector('.form-btns') || iframes[i].contentDocument.body;
              if (body) { body.click(); return; }
            } catch(e) {}
          }
        })()`);
        await sleep(500);
        console.log('[Auto Upload] 视频号编辑：定时发布已设置', editMeta.publish_time);
      }
    }

    // 滚动到「发表」按钮并点击
    await runInPage(`(function() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var btns = iframes[i].contentDocument.querySelectorAll('button.weui-desktop-btn_primary');
          for (var j = 0; j < btns.length; j++) {
            if (btns[j].textContent.trim() === '发表') {
              btns[j].scrollIntoView({ block: 'center', behavior: 'smooth' });
              return;
            }
          }
        } catch(e) {}
      }
    })()`);
    await sleep(1000);
    await runInPage(`(function() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var btns = iframes[i].contentDocument.querySelectorAll('button.weui-desktop-btn_primary');
          for (var j = 0; j < btns.length; j++) {
            if (btns[j].textContent.trim() === '发表') { btns[j].click(); return; }
          }
        } catch(e) {}
      }
    })()`);
    console.log('[Auto Upload] 视频号编辑：已点击发表按钮');
    await sleep(3000);

    // 处理可能出现的「将此次编辑保留?」弹窗 → 点击「不保留」离开
    await runInPage(`(function() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var doc = iframes[i].contentDocument;
          var title = doc.querySelector('.weui-desktop-dialog__title');
          if (title && title.textContent.trim() === '将此次编辑保留?') {
            var btns = doc.querySelectorAll('.weui-desktop-dialog .weui-desktop-btn');
            for (var j = 0; j < btns.length; j++) {
              if (btns[j].textContent.trim() === '不保留') { btns[j].click(); return; }
            }
          }
        } catch(e) {}
      }
    })()`);
    await sleep(1000);

    return { status: 'ok' };
  }

  // 视频号编辑续接（在发布页执行）
  async function channelsEditContinue(taskId, meta) {
    // 等待编辑页 iframe 加载
    for (let i = 0; i < 30; i++) {
      const found = await runInPage(`
        (function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              if (doc && doc.querySelector('.post-desc-box .input-editor')) return true;
            } catch(e) {}
          }
          return false;
        })()
      `);
      if (found?.result === true) break;
      await sleep(1000);
    }
    await sleep(2000);

    // 填写标题/描述/标签
    if (meta.title !== undefined || meta.description !== undefined || (meta.tags && meta.tags.length > 0)) {
      const fillResult = await runInPage(`
        (function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              if (!doc) continue;
              var editor = doc.querySelector('.post-desc-box .input-editor');
              if (!editor) continue;
              ${meta.title !== undefined ? `
              editor.innerHTML = '';
              editor.focus();
              document.execCommand('insertText', false, ${JSON.stringify(meta.title || '')});
              ` : ''}
              ${meta.description !== undefined ? `
              document.execCommand('insertText', false, '\\n' + ${JSON.stringify(meta.description || '')});
              ` : ''}
              ${meta.tags && meta.tags.length > 0 ? `
              var tags = ${JSON.stringify(meta.tags)};
              for (var t = 0; t < tags.length; t++) {
                document.execCommand('insertText', false, ' #' + tags[t]);
              }
              ` : ''}
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true };
            } catch(e) {}
          }
          return { ok: false };
        })()
      `);
      console.log('[Auto Upload] 视频号编辑续接：填写结果', fillResult);
      await sleep(1000);
    }

    // 封面修改
    if (meta.cover_path) {
      console.log('[Auto Upload] 视频号编辑续接：开始修改封面');

      // 等待封面编辑按钮出现（视频预览图加载完成）
      for (let i = 0; i < 45; i++) {
        const found = await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btn = iframes[i].contentDocument.querySelector('.edit-btn');
                if (btn && btn.offsetParent) return true;
              } catch(e) {}
            }
            return false;
          })()
        `);
        if (found?.result === true) break;
        await sleep(2000);
      }
      await sleep(3000);

      // 复用上传流程的封面上传函数
      async function editCoverUpload(editBtnSelector, label) {
        const editResult = await chrome.runtime.sendMessage({
          type: 'cdpClickIframe', selector: editBtnSelector,
        });
        console.log(`[Auto Upload] 编辑${label}:`, JSON.stringify(editResult));
        if (!editResult?.ok) return false;

        let addIconFound = false;
        for (let i = 0; i < 5; i++) {
          await sleep(1000);
          const check = await runInPage(`
            (function() {
              var iframes = document.querySelectorAll('iframe');
              for (var i = 0; i < iframes.length; i++) {
                try {
                  var doc = iframes[i].contentDocument;
                  var dialog = doc.querySelector('.cover-set-footer');
                  if (!dialog) continue;
                  var els = doc.querySelectorAll('.add-icon');
                  for (var j = 0; j < els.length; j++) {
                    var r = els[j].getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return { found: true };
                  }
                  return { found: false, dialogOpen: true };
                } catch(e) {}
              }
              return { found: false, dialogOpen: false };
            })()
          `);
          if (check?.result?.found) { addIconFound = true; break; }
          if (check?.result?.dialogOpen) break;
        }

        if (!addIconFound) {
          await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.cover-tips' });
          await sleep(3000);
          for (let i = 0; i < 10; i++) {
            await sleep(1000);
            const check = await runInPage(`
              (function() {
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                  try {
                    var els = iframes[i].contentDocument.querySelectorAll('.add-icon');
                    for (var j = 0; j < els.length; j++) {
                      var r = els[j].getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) return true;
                    }
                  } catch(e) {}
                }
                return false;
              })()
            `);
            if (check?.result === true) { addIconFound = true; break; }
          }
        }

        const coverResult = await chrome.runtime.sendMessage({
          type: 'setFileViaChooser', filePath: meta.cover_path, clickSelector: '.add-icon',
        });
        if (!coverResult?.ok) {
          console.warn(`[Auto Upload] ${label}封面上传失败:`, coverResult?.error);
          return false;
        }
        await sleep(3000);

        await runInPage(`
          (function() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
              try {
                var btn = iframes[i].contentDocument.querySelector('.cover-set-footer .weui-desktop-btn_primary');
                if (btn) { btn.click(); return; }
              } catch(e) {}
            }
          })()
        `);
        await sleep(2000);
        return true;
      }

      await editCoverUpload('.vertical-img-wrap .edit-btn', '个人卡片');

      const hasHorizon = await runInPage(`
        (function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var el = iframes[i].contentDocument.querySelector('.horizon-img-wrap .edit-btn');
              if (el && el.offsetParent) return true;
            } catch(e) {}
          }
          return false;
        })()
      `);
      if (hasHorizon?.result === true) {
        await sleep(1000);
        await editCoverUpload('.horizon-img-wrap .edit-btn', '分享卡片');
      }
      console.log('[Auto Upload] 视频号编辑续接：封面修改完成');
    }

    // 定时发布设置
    if (meta.publish_time !== undefined) {
      if (meta.publish_time === '' || meta.publish_time === null) {
        await runInPage(`
          var doc = document.querySelector('iframe')?.contentDocument;
          var r = doc?.querySelector('.weui-desktop-form__radio[value="0"]');
          if (r) r.click();
        `);
        console.log('[Auto Upload] 视频号编辑续接：已取消定时发布');
        await sleep(500);
      } else {
        const [datePart, timePart] = meta.publish_time.split(' ');
        const [, , targetDay] = datePart.split('-');
        const [targetHour, targetMin] = timePart.split(':');
        const dayNum = String(parseInt(targetDay, 10));
        const hourStr = String(parseInt(targetHour, 10)).padStart(2, '0');
        const minStr = String(parseInt(targetMin, 10)).padStart(2, '0');

        const contTargetMonth = String(parseInt(datePart.split('-')[1], 10));

        await runInPage(`
          var r = document.querySelector('iframe').contentDocument.querySelector('.weui-desktop-form__radio[value="1"]');
          if (r) r.click();
        `);
        await sleep(1000);
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-form__input[placeholder="请选择发表时间"]' });
        await sleep(1000);

        // 选择日期（支持跨月）
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var monthEl = doc.querySelector('.weui-desktop-picker__panel_month .weui-desktop-picker__selected');
          var curMonth = monthEl ? String(parseInt(monthEl.textContent, 10)) : '';
          if (curMonth && curMonth !== ${JSON.stringify(contTargetMonth)}) {
            var nextBtn = doc.querySelector('.weui-desktop-picker__panel_day .weui-desktop-picker__arrow_right') ||
                          doc.querySelector('.weui-desktop-picker__arrow:last-child');
            if (nextBtn) nextBtn.click();
            setTimeout(function() {
              var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
              for (var i = 0; i < links.length; i++) {
                var a = links[i];
                if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
                if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); return; }
              }
            }, 300);
            return;
          }
          var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
          for (var i = 0; i < links.length; i++) {
            var a = links[i];
            if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
            if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); break; }
          }
        })()`);
        await sleep(800);
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-picker__dt' });
        await sleep(1000);

        // 选择小时（通过 scrollTop + 鼠标事件）
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var ol = doc.querySelector('.weui-desktop-picker__time__hour');
          if (!ol) return;
          var items = ol.querySelectorAll('li');
          for (var i = 0; i < items.length; i++) {
            if (items[i].classList.contains('weui-desktop-picker__disabled')) continue;
            if (items[i].textContent.trim() === ${JSON.stringify(hourStr)}) {
              var liH = items[i].offsetHeight;
              ol.scrollTop = i * liH;
              ol.dispatchEvent(new Event('scroll', {bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));
              break;
            }
          }
        })()`);
        await sleep(500);

        // 选择分钟
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var ol = doc.querySelector('.weui-desktop-picker__time__minute');
          if (!ol) return;
          var items = ol.querySelectorAll('li');
          for (var i = 0; i < items.length; i++) {
            if (items[i].classList.contains('weui-desktop-picker__disabled')) continue;
            if (items[i].textContent.trim() === ${JSON.stringify(minStr)}) {
              var liH = items[i].offsetHeight;
              ol.scrollTop = i * liH;
              ol.dispatchEvent(new Event('scroll', {bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
              items[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));
              break;
            }
          }
        })()`);
        await sleep(500);
        await runInPage(`
          var doc = document.querySelector('iframe').contentDocument;
          var body = doc.querySelector('.form-btns') || doc.body;
          if (body) body.click();
        `);
        await sleep(500);
        console.log('[Auto Upload] 视频号编辑续接：定时发布已设置', meta.publish_time);
      }
    }

    // 点击发布按钮
    await runInPage(`(function() {
      var doc = document.querySelector('iframe')?.contentDocument;
      if (!doc) return;
      var btn = doc.querySelector('.weui-desktop-btn_primary');
      if (btn) btn.click();
    })()`);
    console.log('[Auto Upload] 视频号编辑续接：已点击发布按钮');
    await sleep(2000);
  }

  async function channelsDeletePost(taskId, meta) {
    const postIndex = parseInt(meta.post_id, 10);
    if (isNaN(postIndex)) return { status: 'error', error: '缺少 post_id (index)' };

    const indexInPage = await channelsNavigateToPage(postIndex);

    // 强制显示操作区域 + 给删除按钮加临时 ID
    const prepResult = await channelsRunInIframe(`
      const rows = doc.querySelectorAll('.post-feed-item');
      if (${indexInPage} >= rows.length) return { error: '索引超出范围' };
      const row = rows[${indexInPage}];
      const delIcon = row.querySelector('use[*|href="#icon-feed-del"]');
      if (!delIcon) return { error: '找不到删除按钮' };
      const opr = row.querySelector('.opr');
      if (opr) opr.style.cssText = 'opacity:1 !important; visibility:visible !important; display:flex !important;';
      row.querySelectorAll('.opr-item-wrap').forEach(function(el) {
        el.style.cssText = 'opacity:1 !important; visibility:visible !important; display:flex !important;';
      });
      const delBtn = delIcon.closest('.opr-item') || delIcon.closest('.opr-item-wrap');
      delBtn.id = '__channels_del_tmp';
      row.scrollIntoView({ block: 'center' });
      return { ok: true };
    `);
    if (prepResult?.error) return { status: 'error', error: prepResult.error };
    await sleep(500);

    await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '#__channels_del_tmp' });
    await sleep(1500);

    // 清理临时 ID
    await channelsRunInIframe(`
      const el = doc.getElementById('__channels_del_tmp');
      if (el) el.id = '';
      return true;
    `);

    // 确认删除弹窗（精确匹配 .weui-desktop-dialog 内的确定按钮）
    // 等待弹窗出现
    await sleep(500);
    const confirmResult = await chrome.runtime.sendMessage({
      type: 'runInPage',
      expression: `(function() {
        // 查找删除确认弹窗（标题包含"删除"的 dialog）
        const dialogs = document.querySelectorAll('.weui-desktop-dialog');
        for (const dialog of dialogs) {
          if (dialog.offsetParent === null && !dialog.closest('[style*="display: none"]') === false) continue;
          const title = dialog.querySelector('.weui-desktop-dialog__title');
          if (!title || !title.textContent.includes('删除')) continue;
          const btn = dialog.querySelector('.weui-desktop-btn_primary');
          if (btn) { btn.click(); return { ok: true }; }
        }
        // fallback: iframe 中查找
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument;
            if (!doc) continue;
            const idialogs = doc.querySelectorAll('.weui-desktop-dialog');
            for (const dialog of idialogs) {
              const title = dialog.querySelector('.weui-desktop-dialog__title');
              if (!title || !title.textContent.includes('删除')) continue;
              const btn = dialog.querySelector('.weui-desktop-btn_primary');
              if (btn) { btn.click(); return { ok: true }; }
            }
          } catch(e) {}
        }
        return { ok: false };
      })()`
    });
    if (confirmResult?.result?.ok) {
      console.log('[Auto Upload] 视频号删除：已确认删除');
      await sleep(1000);
      return { status: 'ok' };
    }

    return { status: 'error', error: '未找到删除确认按钮' };
  }

  // 视频号：批量删除所有内容，在同一个进程里反复删第一条直到清空
  async function channelsDeleteAllPosts(taskId, meta) {
    let deleted = 0, failed = 0;

    while (true) {
      // 等待列表加载
      let count = 0;
      for (let i = 0; i < 15; i++) {
        count = await channelsRunInIframe('return doc.querySelectorAll(".post-feed-item").length;');
        if (count && count > 0) break;
        await sleep(1000);
      }
      if (!count || count === 0) break;  // 没有更多了

      // 删除第一条（index=0）
      const r = await channelsDeletePost(taskId, { post_id: '0' });
      if (r.status === 'ok') {
        deleted++;
        await sleep(1000);
      } else {
        failed++;
        if (failed > 5) break;  // 连续失败 5 次，退出
        await sleep(2000);
      }
    }

    return { status: 'ok', deleted, failed };
  }

  // -------------------------------------------------------------------------
  // 抖音 — 内容管理
  // -------------------------------------------------------------------------

  // 等待抖音内容列表加载
  async function douyinWaitForList() {
    for (let i = 0; i < 30; i++) {
      const container = document.querySelector('[class*="content-body"]');
      if (container && container.childElementCount > 0) return;
      await sleep(1000);
    }
  }

  // 滚动加载抖音全部内容
  async function douyinScrollLoadAll() {
    await douyinWaitForList();
    const scrollContainer = document.querySelector('[class*="content-body"]') || document.documentElement;
    let prevCount = 0, stableRounds = 0;
    for (let i = 0; i < 100; i++) {
      const currentCount = scrollContainer.childElementCount;
      if (currentCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
        prevCount = currentCount;
      }
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1000);
    }
    window.scrollTo(0, 0);
    await sleep(500);
  }

  async function douyinListPosts(taskId, meta) {
    await douyinScrollLoadAll();

    const statusFilter = meta.status_filter || '';
    const posts = [];

    // 抖音内容管理页：卡片式布局，每个卡片是 content-body 的直接子 div
    const container = document.querySelector('[class*="content-body"]');
    const cards = container ? Array.from(container.children).filter(el => el.tagName === 'DIV' && el.querySelector('[class*="video-card"], [class*="info-title"]')) : [];
    console.log(`[Auto Upload] 抖音列表：共加载 ${cards.length} 条记录`);

    for (const card of cards) {
      // 标题
      const titleEl = card.querySelector('[class*="info-title-text"]');
      const title = titleEl ? titleEl.textContent.trim() : '';

      // 时间
      const timeEl = card.querySelector('[class*="info-time"]');
      const publishTime = timeEl ? timeEl.textContent.trim() : '';

      // 封面
      let coverUrl = '';
      const coverImg = card.querySelector('[class*="video-card-cover"] img');
      if (coverImg) coverUrl = coverImg.src || '';
      // fallback: background-image
      if (!coverUrl) {
        const coverEl = card.querySelector('[class*="video-card-cover"]');
        if (coverEl) {
          // 查找带 background-image 的子元素
          const bgEl = coverEl.querySelector('[style*="background"]') || coverEl;
          const bg = bgEl.style.backgroundImage || getComputedStyle(bgEl).backgroundImage;
          const bgMatch = bg && bg.match(/url\(["']?(.*?)["']?\)/);
          if (bgMatch) coverUrl = bgMatch[1];
        }
      }

      // post_id：从卡片内的链接、data 属性、或 DOM 属性提取
      let postId = '';
      const allLinks = card.querySelectorAll('a[href]');
      for (const a of allLinks) {
        const m = a.href.match(/\/(?:video|content|item)\/(\d+)/);
        if (m) { postId = m[1]; break; }
      }
      if (!postId) {
        postId = card.getAttribute('data-id') || card.getAttribute('data-video-id') || '';
      }
      if (!postId) {
        // 从所有子元素的 data 属性搜索
        const idEl = card.querySelector('[data-id],[data-video-id],[data-item-id]');
        if (idEl) postId = idEl.getAttribute('data-id') || idEl.getAttribute('data-video-id') || idEl.getAttribute('data-item-id') || '';
      }
      if (!postId) {
        postId = title ? 'title_' + title.substring(0, 20) : '';
      }

      // 状态
      const cardText = card.innerText || '';
      let pubStatus = 'published';
      if (/审核中/.test(cardText)) pubStatus = '审核中';
      else if (/定时发布/.test(cardText)) pubStatus = 'scheduled';
      else if (/草稿/.test(cardText)) pubStatus = 'draft';
      else if (/未通过/.test(cardText)) pubStatus = '未通过';
      else if (/私密/.test(cardText)) pubStatus = '私密';

      if (statusFilter) {
        if (statusFilter !== pubStatus) continue;
      }

      // 数据（播放、点赞、评论、分享）
      const metricEls = card.querySelectorAll('[class*="metric"]');
      const metrics = {};
      for (const mel of metricEls) {
        const text = mel.innerText.trim();
        const match = text.match(/(播放|点赞|评论|分享)\s*\n?\s*(\d[\d,.万亿]*)/);
        if (match) metrics[match[1]] = match[2];
      }

      posts.push({
        post_id: postId,
        title,
        status: pubStatus,
        publish_time: publishTime,
        cover_url: coverUrl,
        metrics,
      });
    }

    return { status: 'ok', posts };
  }

  // 抖音管理页：根据 post_id 或标题找到目标卡片
  function douyinFindCard(postId) {
    const container = document.querySelector('[class*="content-body"]');
    if (!container) return null;
    const cards = Array.from(container.children).filter(el => el.tagName === 'DIV');
    for (const card of cards) {
      // 通过链接里的 ID 匹配
      const allLinks = card.querySelectorAll('a[href]');
      for (const a of allLinks) {
        if (a.href.includes(postId)) return card;
      }
      // 通过 data 属性匹配
      if (card.getAttribute('data-id') === postId || card.getAttribute('data-video-id') === postId) return card;
      // 通过 title_ 前缀匹配（list_posts 生成的标题 ID）
      if (postId.startsWith('title_')) {
        const titleEl = card.querySelector('[class*="info-title-text"]');
        if (titleEl && titleEl.textContent.trim().startsWith(postId.substring(6))) return card;
      }
    }
    return null;
  }

  async function douyinEditPost(taskId, meta) {
    await douyinWaitForList();

    const postId = meta.post_id;
    if (!postId) return { status: 'error', error: '缺少 post_id' };

    const targetCard = douyinFindCard(postId);
    if (!targetCard) return { status: 'error', error: `找不到 post_id=${postId} 的内容` };

    // 点击编辑按钮（已发布="编辑作品"，定时发布="继续编辑"）
    const editBtn = Array.from(targetCard.querySelectorAll('div,span,button')).find(
      el => el.offsetParent && el.childElementCount === 0 && /^(编辑作品|继续编辑|编辑)$/.test((el.textContent || '').trim())
    );
    if (!editBtn) {
      return { status: 'error', error: '找不到编辑按钮（审核中的作品无法编辑）' };
    }
    editBtn.click();

    // 等待编辑页面加载
    await sleep(3000);
    for (let i = 0; i < 30; i++) {
      const titleInput = document.querySelector(
        'input[placeholder*="标题"], input[placeholder*="作品标题"], [class*="title-input"] input'
      );
      const descEditor = document.querySelector(
        '.editor-kit-container[contenteditable="true"], [contenteditable="true"][class*="editor"], [class*="notranslate"][contenteditable="true"]'
      );
      if (titleInput || descEditor) break;
      await sleep(1000);
    }
    await sleep(1000);

    const editMeta = meta.meta || {};

    // 修改标题
    if (editMeta.title !== undefined) {
      const titleEl = document.querySelector(
        'input[placeholder*="标题"], input[placeholder*="作品标题"], [class*="title-input"] input'
      );
      if (titleEl) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(titleEl, editMeta.title);
        titleEl.dispatchEvent(new Event('input', { bubbles: true }));
        titleEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // 修改描述 + 标签
    if (editMeta.description !== undefined || (editMeta.tags && editMeta.tags.length > 0)) {
      const descEl = document.querySelector(
        '.editor-kit-container[contenteditable="true"], [contenteditable="true"][class*="editor"], [class*="notranslate"][contenteditable="true"]'
      );
      if (descEl) {
        descEl.focus();
        await sleep(300);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(200);

        if (editMeta.description) {
          document.execCommand('insertText', false, editMeta.description);
          descEl.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(300);
        }

        if (editMeta.tags && editMeta.tags.length > 0) {
          if (editMeta.description) {
            document.execCommand('insertText', false, ' ');
            await sleep(200);
          }
          for (const tag of editMeta.tags) {
            document.execCommand('insertText', false, `#${tag}`);
            descEl.dispatchEvent(new Event('input', { bubbles: true }));
            let topicPopup = null;
            for (let i = 0; i < 8; i++) {
              await sleep(300);
              topicPopup = document.querySelector('[class*="topic-container"], [class*="topic-list"], [class*="mention-list"]');
              if (topicPopup) break;
            }
            if (topicPopup) {
              const firstItem = topicPopup.querySelector('[class*="item"], [class*="option"], li');
              if (firstItem) { firstItem.click(); await sleep(400); }
              descEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              descEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
              await sleep(300);
            } else {
              document.execCommand('insertText', false, ' ');
              await sleep(200);
            }
          }
        }
      }
    }

    // 点击保存/发布
    await sleep(500);
    document.body.click();
    await sleep(500);

    const saveBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
    for (const btn of saveBtns) {
      const text = (btn.textContent || '').trim();
      if (text === '保存' || text === '发布' || text === '确认') {
        btn.click();
        await sleep(2000);
        break;
      }
    }

    return { status: 'ok' };
  }

  async function douyinDeletePost(taskId, meta) {
    await douyinScrollLoadAll();

    const postId = meta.post_id;
    if (!postId) return { status: 'error', error: '缺少 post_id' };

    const targetCard = douyinFindCard(postId);
    if (!targetCard) return { status: 'error', error: `找不到 post_id=${postId} 的内容` };

    // 点击"删除作品"按钮（卡片内直接有此按钮）
    const delBtn = Array.from(targetCard.querySelectorAll('div,span,button')).find(
      el => el.offsetParent && el.childElementCount === 0 && (el.textContent || '').trim() === '删除作品'
    );
    if (!delBtn) return { status: 'error', error: '找不到删除作品按钮' };
    delBtn.click();
    await sleep(1000);

    // 确认删除弹窗
    const confirmBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
    for (const btn of confirmBtns) {
      const text = (btn.textContent || '').trim();
      if (text === '确认' || text === '确定' || text === '删除' || text === '确认删除') {
        btn.click();
        await sleep(1500);
        return { status: 'ok' };
      }
    }

    return { status: 'error', error: '未找到删除确认按钮' };
  }

  // 抖音删除单个卡片的通用函数
  async function douyinDeleteCard(card) {
    const delBtn = Array.from(card.querySelectorAll('div,span,button')).find(
      el => el.offsetParent && el.childElementCount === 0 && (el.textContent || '').trim() === '删除作品'
    );
    if (!delBtn) return false;
    delBtn.click();
    await sleep(1000);

    // 确认删除弹窗
    const confirmBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
    for (const btn of confirmBtns) {
      const text = (btn.textContent || '').trim();
      if (text === '确认' || text === '确定' || text === '删除' || text === '确认删除') {
        btn.click();
        await sleep(1500);
        return true;
      }
    }
    // 关闭可能的弹窗
    for (const btn of confirmBtns) {
      const text = (btn.textContent || '').trim();
      if (text === '取消' || text === '关闭') { btn.click(); break; }
    }
    await sleep(500);
    return false;
  }

  async function douyinDeleteAllPosts(taskId, meta) {
    await douyinScrollLoadAll();

    let deleted = 0, failed = 0;

    while (true) {
      const container = document.querySelector('[class*="content-body"]');
      const cards = container ? Array.from(container.children).filter(el => el.tagName === 'DIV' && el.querySelector('[class*="info-title"]')) : [];
      if (cards.length === 0) break;

      const ok = await douyinDeleteCard(cards[0]);
      if (ok) {
        deleted++;
      } else {
        failed++;
        if (failed > 5) break; // 连续失败太多次就停止
      }
    }

    return { status: 'ok', deleted, failed };
  }

  async function douyinDeleteBatch(taskId, meta) {
    const postIds = meta.post_ids || [];
    if (!postIds.length) return { status: 'error', error: '缺少 post_ids' };

    await douyinScrollLoadAll();

    let deleted = 0, failed = 0, notFound = 0;

    for (const postId of postIds) {
      const targetCard = douyinFindCard(postId);
      if (!targetCard) { notFound++; continue; }

      const ok = await douyinDeleteCard(targetCard);
      if (ok) {
        deleted++;
      } else {
        failed++;
      }
    }

    return { status: 'ok', deleted, failed, not_found: notFound };
  }

  // -------------------------------------------------------------------------
  // 轮询主循环
  // -------------------------------------------------------------------------

  let _running = false;

  async function pollLoop() {
    while (true) {
      await sleep(2000);

      if (_running) continue;

      try {
        // 先检查是否有登录请求
        const loginResp = await fetch(`${BASE_URL}/login_request`);
        if (loginResp.ok) {
          const loginReq = await loginResp.json();
          if (loginReq && loginReq.account_id) {
            // 如果请求指定了平台但当前页面不是该平台，把请求放回再跳过
            const myPlatform = getPlatform();
            if (loginReq.platform && loginReq.platform !== myPlatform) {
              await postJSON('/restore_login_request', loginReq);
              continue;
            }
            _running = true;
            try {
              await checkAndHandleLogin(loginReq.account_id);
            } finally {
              _running = false;
            }
            continue;
          }
        }
      } catch (e) {
        // 本地服务未启动或网络错误，静默忽略
      }

      // 检查是否有退出登录请求
      try {
        const logoutResp = await fetch(`${BASE_URL}/logout_request`);
        if (logoutResp.ok) {
          const logoutReq = await logoutResp.json();
          if (logoutReq && logoutReq.account_id) {
            const myPlatform = getPlatform();
            if (!logoutReq.platform || logoutReq.platform === myPlatform) {
              console.log(`[Auto Upload] 收到退出登录请求, 平台: ${logoutReq.platform}`);
              try {
                if (logoutReq.platform === 'xiaohongshu') {
                  // 小红书：点击头像 → 展开菜单 → 点击"退出登录"
                  const userInfo = document.querySelector('.user-info');
                  if (userInfo) {
                    userInfo.click();
                    await sleep(800);
                    const menuItems = document.querySelectorAll('.menu-list .popover_text span');
                    let logoutBtn = null;
                    for (const span of menuItems) {
                      if ((span.textContent || '').includes('退出登录')) {
                        logoutBtn = span.closest('.popover_text');
                        break;
                      }
                    }
                    if (logoutBtn) {
                      logoutBtn.click();
                      await sleep(1000);
                      // 处理确认弹窗：点击"确定"按钮
                      const confirmBtn = document.querySelector('.logout-modal .model-footer-confirm-btn');
                      if (confirmBtn) {
                        confirmBtn.click();
                        await sleep(1500);
                        console.log('[Auto Upload] 小红书退出登录 - 已点击确认');
                      }
                      await postJSON('/logout_status', {
                        account_id: logoutReq.account_id,
                        status: 'ok',
                      });
                      console.log('[Auto Upload] 小红书退出登录成功');
                      chrome.runtime.sendMessage({ type: 'closeTab' });
                    } else {
                      await postJSON('/logout_status', {
                        account_id: logoutReq.account_id,
                        status: 'error',
                        error: '未找到退出登录按钮',
                      });
                    }
                  } else {
                    await postJSON('/logout_status', {
                      account_id: logoutReq.account_id,
                      status: 'error',
                      error: '未找到用户信息区域（可能未登录）',
                    });
                  }
                } else {
                  // 其他平台：用 cookie 清除方式兜底
                  const result = await chrome.runtime.sendMessage({
                    type: 'clearCookies',
                    domain: logoutReq.domain,
                  });
                  await postJSON('/logout_status', {
                    account_id: logoutReq.account_id,
                    status: result?.ok ? 'ok' : 'error',
                    removed: result?.removed || 0,
                    error: result?.error || '',
                  });
                }
              } catch (e) {
                await postJSON('/logout_status', {
                  account_id: logoutReq.account_id,
                  status: 'error',
                  error: e.message,
                });
              }
              console.log('[Auto Upload] 退出登录流程结束');
              chrome.runtime.sendMessage({ type: 'closeTab' });
            }
          }
        }
      } catch (e) {
        // 静默忽略
      }

      try {
        const resp = await fetch(`${BASE_URL}/task`);
        if (!resp.ok) continue;
        const task = await resp.json();
        if (task && task.task_id) {
          // 如果任务指定了平台但当前页面不是该平台，放回再跳过
          const myPlatform = getPlatform();
          if (task.platform && task.platform !== myPlatform) {
            await postJSON('/restore_task', task);
            continue;
          }

          // 多标签页保护：检查当前页面是否适合处理该任务类型
          const isManageTask = !!(task.meta && task.meta._manage_type);
          const path = location.pathname;
          const isOnUploadPage = path.includes('/create') || path.includes('/publish') || path.includes('/upload');
          const isOnManagePage = path.includes('/list') || path.includes('/manage') || path.includes('/note-manager');

          if (!isManageTask && !isOnUploadPage) {
            // 上传任务需要在上传/创建页面执行，当前页面不适合
            console.log('[Auto Upload] 当前页面非上传页，放回上传任务:', path);
            await postJSON('/restore_task', task);
            await sleep(5000); // 等待正确标签页加载
            continue;
          }
          if (isManageTask && !isOnManagePage) {
            // 管理任务需要在管理/列表页面执行，当前页面不适合
            console.log('[Auto Upload] 当前页面非管理页，放回管理任务:', path);
            await postJSON('/restore_task', task);
            await sleep(5000); // 等待正确标签页加载
            continue;
          }

          _running = true;
          try {
            await runTask(task);
          } finally {
            _running = false;
          }
        }
      } catch (e) {
        // 本地服务未启动或网络错误，静默忽略
      }
    }
  }

  // 非顶层 frame 不运行 poll loop（避免 iframe 重复轮询）
  if (!IS_TOP_FRAME) return;

  // 检测跨页面登录：扫码后页面跳转，新页面的 content.js 在此上报 confirmed
  (async () => {
    const pendingId = localStorage.getItem(LOGIN_PENDING_KEY);
    console.log('[Auto Upload] 启动检测 pendingId:', pendingId, 'isOnLoginPage:', isOnLoginPage(), 'url:', location.href);
    if (pendingId && !isOnLoginPage()) {
      localStorage.removeItem(LOGIN_PENDING_KEY);
      await postJSON('/login_status', { account_id: pendingId, status: 'confirmed' });
      console.log('[Auto Upload] 跨页面登录已确认:', pendingId);
      await sleep(500);
      chrome.runtime.sendMessage({ type: 'closeTab' });
    }
  })();

  pollLoop();
  console.log('[Auto Upload] content.js 已启动，轮询中...');
})();
