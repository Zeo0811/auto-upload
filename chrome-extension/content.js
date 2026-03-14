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
      return !!(document.querySelector('[class*="qrcode-wrap"], [class*="login-qrcode"]') ||
                Array.from(document.querySelectorAll('span,div')).some(el => el.childElementCount === 0 && (el.textContent || '').includes('微信扫码登录')));
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
    return checkAndHandleXhsLogin(accountId);
  }

  // 小红书登录
  async function checkAndHandleXhsLogin(accountId) {
    // 尝试切换到二维码模式
    const qrSwitchBtn = document.querySelector('.login-box-container img:first-child');
    if (qrSwitchBtn) { qrSwitchBtn.click(); await sleep(1500); }

    // 取 src 最长的 data:image（QR 远大于小图标）
    await sleep(2000);
    const allDataImgs = Array.from(document.querySelectorAll('img[src^="data:image"]'));
    const qrImg = allDataImgs.sort((a, b) => b.src.length - a.src.length)[0];
    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64: qrImg ? qrImg.src : '',
    });

    localStorage.setItem(LOGIN_PENDING_KEY, accountId);
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!isOnLoginPage()) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'confirmed' });
        return true;
      }
    }
    localStorage.removeItem(LOGIN_PENDING_KEY);
    await postJSON('/login_status', { account_id: accountId, status: 'error', error: 'QR 超时' });
    return false;
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

    // 重新取坐标 —— 找水平最居中的那个（carousel 里有多个 .login-content）
    const allContents = Array.from(document.querySelectorAll('.login-content'));
    const vw = window.innerWidth;
    loginContent = allContents.reduce((best, el) => {
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
      const r = loginContent.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // getBoundingClientRect 是视口坐标，CDP clip 需要页面坐标（加上滚动偏移）
        clip = {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          width: r.width,
          height: r.height,
        };
        console.log('[Auto Upload] 截图区域 .login-content:', clip, 'scroll:', window.scrollX, window.scrollY);
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

    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64,
      qr_url: '',
    });

    localStorage.setItem(LOGIN_PENDING_KEY, accountId);
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);

      // 登录成功：离开了登录页
      if (!isOnLoginPage()) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'confirmed' });
        return true;
      }

      // 二维码过期：显示了"已过期"遮罩
      const expired = Array.from(document.querySelectorAll('.qrcode-wrap .mask')).find(
        m => m.offsetParent && (m.innerText || '').includes('已过期')
      );
      if (expired) {
        localStorage.removeItem(LOGIN_PENDING_KEY);
        await postJSON('/login_status', { account_id: accountId, status: 'error', error: '二维码已过期，请重新调用 login()' });
        return false;
      }
    }

    localStorage.removeItem(LOGIN_PENDING_KEY);
    await postJSON('/login_status', { account_id: accountId, status: 'error', error: 'QR 超时' });
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
        else throw new Error(`不支持的管理操作: ${manageType}`);
      } else if (platform === 'channels') {
        if (manageType === 'list_posts')  result = await channelsListPosts(task_id, meta);
        else if (manageType === 'edit_post')   result = await channelsEditPost(task_id, meta);
        else if (manageType === 'delete_post') result = await channelsDeletePost(task_id, meta);
        else if (manageType === 'channels_edit_continue') {
          await channelsEditContinue(task_id, meta);
          result = { status: 'ok' };
        }
        else throw new Error(`不支持的管理操作: ${manageType}`);
      } else {
        throw new Error(`平台 ${platform} 不支持管理操作`);
      }
      // _deferred 表示结果由后续任务回传（如视频号编辑跳转）
      if (!result?._deferred) {
        await postJSON('/task_result', { task_id, ...result });
      }
    } catch (e) {
      console.error('[Auto Upload] 管理操作失败:', e);
      await postJSON('/task_result', { task_id, status: 'error', error: e.message });
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
      // 优先 Quill 编辑器，再退而求其次用带 placeholder 的 contenteditable（比裸 [contenteditable] 更精确）
      const descEl = document.querySelector(
        '.ql-editor, [contenteditable="true"][data-placeholder], textarea[placeholder*="描述"], textarea[placeholder*="内容"]'
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
              topicPopup = document.querySelector('#creator-editor-topic-container');
              if (topicPopup) break;
            }

            if (topicPopup) {
              // 点击第一个建议项选中话题，再按 Enter 确认
              const firstItem = topicPopup.querySelector('.item.is-selected') ||
                                topicPopup.querySelector('.item');
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
      await sleep(1000);
      // 点击编辑器外部收起任何残留弹窗
      document.querySelector('.publish-page-content')?.click();
      await sleep(500);

      // 8.5 上传封面图
      if (meta && meta.cover_path) {
        await postJSON('/progress', { task_id, progress: 82, msg: '准备上传封面' });

        // Step 1: 滚到封面区域，点击 operator 展开上传面板
        const coverOperator = document.querySelector('.cover-plugin-preview .operator') ||
                              document.querySelector('.cover-plugin-preview [class*="operator"]');
        if (coverOperator) {
          coverOperator.scrollIntoView({ block: 'center' });
          await sleep(500);
          coverOperator.click();
          await sleep(1500);
        }

        // Step 2: 确保 .upload-btn 可见后再拦截
        const uploadBtn = document.querySelector('.upload-btn');
        if (uploadBtn) {
          uploadBtn.scrollIntoView({ block: 'center' });
          await sleep(400);
        }

        const coverResult = await chrome.runtime.sendMessage({
          type: 'interceptAndSetFile',
          filePath: meta.cover_path,
          clickSelector: '.upload-btn',
        });
        if (!coverResult || !coverResult.ok) {
          console.warn('[Auto Upload] 封面上传失败:', coverResult?.error);
        }

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
      }

      // 8.6 定时发布
      if (meta && meta.publish_time) {
        await postJSON('/progress', { task_id, progress: 85, msg: '设置定时发布' });

        // publish_time 格式: "2026-03-16 08:00"
        const [datePart, timePart] = meta.publish_time.split(' ');
        const [, , targetDay]  = datePart.split('-');   // "16"
        const [targetHour, targetMin] = timePart.split(':'); // "08", "00"
        const targetDayNum = String(parseInt(targetDay, 10));

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
        // 用 .d-switch-simulator 的 unchecked class 判断状态（Vue checkbox .checked 属性不可靠）
        let scheduleSwitch = null;
        for (let i = 0; i < 10; i++) {
          scheduleSwitch = document.querySelector('.post-time-wrapper .d-switch-simulator');
          if (scheduleSwitch) break;
          await sleep(500);
        }
        const isUnchecked = scheduleSwitch?.classList.contains('unchecked');
        if (scheduleSwitch && isUnchecked) {
          scheduleSwitch.scrollIntoView({ block: 'center' });
          await sleep(600);
          scheduleSwitch.click();
          await sleep(1500);
        }

        // Step A: 等待日期输入框出现并 CDP 点击打开弹窗
        let dtInput = null;
        for (let i = 0; i < 8; i++) {
          dtInput = document.querySelector('.d-datepicker input');
          if (dtInput) break;
          await sleep(500);
        }
        if (dtInput) {
          await cdpClickEl(dtInput);
          await sleep(800);

          // Step B: 等弹窗出现
          let popover = null;
          for (let i = 0; i < 10; i++) {
            popover = document.querySelector('.post-time-date-picker-popover-class');
            if (popover) break;
            await sleep(300);
          }
          if (popover) {
            // Step C: 点击目标日期
            const dayCells = Array.from(popover.querySelectorAll('.d-datepicker-cell.d-clickable:not(.disabled)'));
            const dayCell = dayCells.find(c =>
              (c.querySelector('span.d-text-monospace') || c.querySelector('span') || c).textContent.trim() === targetDayNum
            );
            if (dayCell) { await cdpClickEl(dayCell); await sleep(600); }

            // Step D: 点击小时 + 分钟
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

        await sleep(500);
        await postJSON('/progress', { task_id, progress: 87, msg: `定时发布已设置: ${meta.publish_time}` });
        await sleep(1000);
      }

      // 9. 点击发布按钮
      let published = false;

      // 优先尝试指定选择器
      const publishBtn = document.querySelector('.publish-page-publish-btn button');
      if (publishBtn) {
        publishBtn.removeAttribute('disabled');
        publishBtn.click();
        published = true;
      }

      // fallback：遍历所有按钮找含"发布"文字的
      if (!published) {
        const allBtns = Array.from(document.querySelectorAll('button'));
        for (const btn of allBtns) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (text.includes('发布') && !text.includes('草稿')) {
            btn.removeAttribute('disabled');
            btn.click();
            published = true;
            break;
          }
        }
      }

      if (!published) {
        throw new Error('未找到发布按钮');
      }
      await postJSON('/progress', { task_id, progress: 90, msg: '已点击发布按钮' });

      // 10. 等待并持续清弹窗（5 秒）
      await dismissPopupsRounds(5, 1000);

      // 用 sendBeacon 保证页面跳转时也能发出（fetch 在页面卸载时会被中止）
      const postUrl = location.href;
      navigator.sendBeacon(BASE_URL + '/done', JSON.stringify({ task_id, post_url: postUrl }));
      console.log('[Auto Upload] 任务完成', task_id);

    } catch (e) {
      console.error('[Auto Upload] 任务失败', task_id, e);
      navigator.sendBeacon(BASE_URL + '/fail', JSON.stringify({ task_id, error: e.message || String(e) }));
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

      // Step 1: 等页面稳定
      await sleep(2000);

      // Step 2: 向 iframe 内的隐藏 file input 注入文件
      await postJSON('/progress', { task_id, progress: 10, msg: '视频号：注入视频文件' });
      const setResult = await chrome.runtime.sendMessage({
        type: 'setFileInput',
        filePath: task.file_path,
        selector: 'input[type="file"]',
      });
      if (!setResult || !setResult.ok) throw new Error('视频注入失败: ' + (setResult?.error || '未知'));

      // Step 3: 等待上传完成（在页面 JS 上下文检查 iframe 里的表单）
      await postJSON('/progress', { task_id, progress: 15, msg: '视频号：等待上传完成' });
      const uploadTimeout = 10 * 60 * 1000;
      const uploadStart = Date.now();
      let editorVisible = false;
      while (Date.now() - uploadStart < uploadTimeout) {
        await sleep(2000);
        const r = await runInPage(
          `!!(document.querySelector('iframe') && document.querySelector('iframe').contentDocument && document.querySelector('iframe').contentDocument.querySelector('.post-desc-box .input-editor'))`
        );
        if (r && r.result === true) { editorVisible = true; break; }
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
                  if (editBtn && editBtn.offsetParent) return true;
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

        // 点击日期输入框打开日期选择器
        await chrome.runtime.sendMessage({
          type: 'cdpClickIframe',
          selector: '.weui-desktop-form__input[placeholder="请选择发表时间"]',
        });
        await sleep(1000);

        // 选择日期
        await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
            for (var i = 0; i < links.length; i++) {
              var a = links[i];
              if (a.classList.contains('weui-desktop-picker__disabled')) continue;
              if (a.classList.contains('weui-desktop-picker__faded')) continue;
              if (a.textContent.trim() === ${JSON.stringify(dayNum)}) {
                a.click();
                break;
              }
            }
          })()
        `);
        await sleep(500);

        // 点击时间区域展开时间面板
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-picker__dt' });
        await sleep(1000);

        // 选择小时：滚动到目标并模拟完整鼠标事件
        await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var hours = doc.querySelectorAll('.weui-desktop-picker__time__hour li');
            for (var i = 0; i < hours.length; i++) {
              if (hours[i].classList.contains('weui-desktop-picker__disabled')) continue;
              if (hours[i].textContent.trim() === ${JSON.stringify(hourStr)}) {
                hours[i].scrollIntoView({ block: 'center' });
                hours[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                hours[i].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                hours[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
                break;
              }
            }
          })()
        `);
        await sleep(500);

        // 选择分钟
        await runInPage(`
          (function() {
            var doc = document.querySelector('iframe').contentDocument;
            var mins = doc.querySelectorAll('.weui-desktop-picker__time__minute li');
            for (var i = 0; i < mins.length; i++) {
              if (mins[i].classList.contains('weui-desktop-picker__disabled')) continue;
              if (mins[i].textContent.trim() === ${JSON.stringify(minStr)}) {
                mins[i].scrollIntoView({ block: 'center' });
                mins[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                mins[i].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                mins[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
                break;
              }
            }
          })()
        `);
        await sleep(500);

        // 关闭弹窗
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

      // Step 6: 点击发表
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

    } catch (e) {
      console.error('[Auto Upload] 视频号任务失败', task_id, e);
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
        scheduleSwitch = document.querySelector('.post-time-wrapper .d-switch-simulator');
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

    // 点击发布/保存按钮（用 CDP 点击确保生效）
    const publishBtn = document.querySelector('.publish-page-publish-btn button');
    if (publishBtn) {
      publishBtn.scrollIntoView({ block: 'center' });
      await sleep(500);
      await chrome.runtime.sendMessage({ type: 'cdpClick', selector: '.publish-page-publish-btn button' });
      console.log('[Auto Upload] 编辑：已点击发布按钮');
      await sleep(2000);
    } else {
      console.warn('[Auto Upload] 编辑：未找到发布按钮');
    }

    return { status: 'ok' };
  }

  async function xhsDeletePost(taskId, meta) {
    for (let i = 0; i < 30; i++) {
      if (document.querySelectorAll('.note').length > 0) break;
      await sleep(1000);
    }
    await sleep(1000);

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
        console.log(`[Auto Upload] 视频号编辑：定时发布解析 原始值="${editMeta.publish_time}" 日=${dayNum} 时=${hourStr} 分=${minStr}`);

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

        // 选择日期
        await runInPage(`(function() {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
              for (var j = 0; j < links.length; j++) {
                var a = links[j];
                if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
                if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); return; }
              }
            } catch(e) {}
          }
        })()`);
        await sleep(500);

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

        await runInPage(`
          var r = document.querySelector('iframe').contentDocument.querySelector('.weui-desktop-form__radio[value="1"]');
          if (r) r.click();
        `);
        await sleep(1000);
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-form__input[placeholder="请选择发表时间"]' });
        await sleep(1000);
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var links = doc.querySelectorAll('.weui-desktop-picker__panel_day a');
          for (var i = 0; i < links.length; i++) {
            var a = links[i];
            if (a.classList.contains('weui-desktop-picker__disabled') || a.classList.contains('weui-desktop-picker__faded')) continue;
            if (a.textContent.trim() === ${JSON.stringify(dayNum)}) { a.click(); break; }
          }
        })()`);
        await sleep(500);
        await chrome.runtime.sendMessage({ type: 'cdpClickIframe', selector: '.weui-desktop-picker__dt' });
        await sleep(1000);
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var hours = doc.querySelectorAll('.weui-desktop-picker__time__hour li');
          for (var i = 0; i < hours.length; i++) {
            if (hours[i].classList.contains('weui-desktop-picker__disabled')) continue;
            if (hours[i].textContent.trim() === ${JSON.stringify(hourStr)}) {
              hours[i].scrollIntoView({block:'center'});
              hours[i].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              hours[i].dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
              hours[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));
              break;
            }
          }
        })()`);
        await sleep(500);
        await runInPage(`(function() {
          var doc = document.querySelector('iframe').contentDocument;
          var mins = doc.querySelectorAll('.weui-desktop-picker__time__minute li');
          for (var i = 0; i < mins.length; i++) {
            if (mins[i].classList.contains('weui-desktop-picker__disabled')) continue;
            if (mins[i].textContent.trim() === ${JSON.stringify(minStr)}) {
              mins[i].scrollIntoView({block:'center'});
              mins[i].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
              mins[i].dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
              mins[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));
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
    if (pendingId && !isOnLoginPage()) {
      localStorage.removeItem(LOGIN_PENDING_KEY);
      await postJSON('/login_status', { account_id: pendingId, status: 'confirmed' });
      console.log('[Auto Upload] 跨页面登录已确认:', pendingId);
    }
  })();

  pollLoop();
  console.log('[Auto Upload] content.js 已启动，轮询中...');
})();
