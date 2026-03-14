(function () {
  'use strict';

  // 防止重复注入
  if (window.__autoUploaderRunning) return;
  window.__autoUploaderRunning = true;

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
      return !!document.querySelector('.login-qrcode-wrap');
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
    await sleep(2000);

    // 取 .qrcode img（精确选择器），src 是 data:image/png;base64
    const qrImg = document.querySelector('.login-qrcode-wrap img.qrcode');
    await postJSON('/login_status', {
      account_id: accountId,
      status: 'qr_required',
      qr_base64: (qrImg && qrImg.src.startsWith('data:image')) ? qrImg.src : '',
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
    console.log('[Auto Upload] 平台:', platform, '任务:', task.task_id);
    if (platform === 'xiaohongshu') return runXhsTask(task);
    if (platform === 'channels')    return runChannelsTask(task);
    throw new Error('当前页面不是支持的平台: ' + location.hostname);
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

        // 等待封面编辑器比例选择出现（最多 15s，不再调用 dismissPopups 以免关掉编辑器）
        let ratioEl = null;
        for (let i = 0; i < 30; i++) {
          ratioEl = document.querySelector('.ratio-select');
          if (ratioEl) break;
          await sleep(500);
        }
        // Step 3: 切换封面比例
        const targetRatio = (meta.cover_ratio || '3:4').replace('：', ':');
        if (ratioEl) {
          // CDP click 打开比例下拉
          await chrome.runtime.sendMessage({ type: 'cdpClick', selector: '.ratio-select' });
          await sleep(1000);

          // 将 "W:H" 或 "W：H" 解析为小数，无法解析返回 null
          const parseRatio = str => {
            const m = str.trim().replace(/：/g, ':').replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
            if (!m) return null;
            const h = parseFloat(m[2]);
            return h === 0 ? null : parseFloat(m[1]) / h;
          };
          const targetVal = parseRatio(targetRatio);

          // 等待比例选项出现（最多 3s），收集所有候选后选最近的
          let option = null;
          for (let i = 0; i < 6; i++) {
            const allEls = Array.from(document.querySelectorAll('li, div, span, button'))
              .filter(el => el.children.length === 0); // 只看叶节点
            const candidates = allEls
              .map(el => ({ el, val: parseRatio(el.innerText || el.textContent || '') }))
              .filter(c => c.val !== null);
            if (candidates.length > 0) {
              if (targetVal !== null) {
                // 按与目标比值的差值排序，取最近的
                candidates.sort((a, b) => Math.abs(a.val - targetVal) - Math.abs(b.val - targetVal));
                option = candidates[0].el;
              } else {
                // 目标无法解析时退回精确文字匹配
                const norm = r => r.trim().replace(/：/g, ':').replace(/\s+/g, '');
                option = allEls.find(el => norm(el.innerText || el.textContent || '') === norm(targetRatio));
              }
              if (option) break;
            }
            await sleep(500);
          }
          if (option) {
            const tmpId = '__xhs_ratio_opt_' + Date.now();
            option.id = tmpId;
            await chrome.runtime.sendMessage({ type: 'cdpClick', selector: `#${tmpId}` });
            option.id = '';
            await sleep(600);
          } else {
            console.warn('[Auto Upload] 未找到比例选项:', targetRatio);
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
  // -------------------------------------------------------------------------

  async function runChannelsTask(task) {
    const { task_id, meta } = task;
    console.log('[Auto Upload] 视频号任务开始', task_id);

    try {
      await postJSON('/progress', { task_id, progress: 5, msg: '视频号：页面准备中' });

      // Step 1: 等页面稳定，清弹窗
      await sleep(2000);
      await dismissPopupsRounds(3, 800);

      // Step 2: 注入视频文件
      // ⚠️ 视频号上传按钮选择器待确认，需要人工提供 DOM
      await postJSON('/progress', { task_id, progress: 10, msg: '视频号：注入视频文件' });
      const setResult = await chrome.runtime.sendMessage({
        type: 'setFileViaChooser',
        filePath: task.file_path,
        clickSelector: 'TODO_需要确认上传按钮选择器',
      });
      if (!setResult || !setResult.ok) throw new Error('视频注入失败: ' + (setResult?.error || '未知'));

      // Step 3: 等待上传完成（标题输入框出现为信号）
      // ⚠️ 标题 input 选择器待确认
      await postJSON('/progress', { task_id, progress: 15, msg: '视频号：等待上传完成' });
      const uploadTimeout = 10 * 60 * 1000;
      const uploadStart = Date.now();
      let titleVisible = false;
      while (Date.now() - uploadStart < uploadTimeout) {
        await sleep(2000);
        dismissPopups();
        // TODO: 替换为实际标题输入框选择器
        const titleEl = document.querySelector('TODO_标题输入框选择器');
        if (titleEl && titleEl.offsetParent) { titleVisible = true; break; }
      }
      if (!titleVisible) throw new Error('等待上传完成超时');

      await postJSON('/progress', { task_id, progress: 70, msg: '视频号：上传完成，填写信息' });
      await sleep(2000);
      await dismissPopupsRounds(3, 800);

      // Step 4: 填写标题
      // ⚠️ 待确认选择器
      if (meta && meta.title) {
        const titleEl = document.querySelector('TODO_标题输入框选择器');
        if (titleEl) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(titleEl, meta.title);
          titleEl.dispatchEvent(new Event('input', { bubbles: true }));
          titleEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Step 5: 填写描述/话题
      // ⚠️ 待确认选择器
      if (meta && (meta.description || meta.tags?.length)) {
        const descEl = document.querySelector('TODO_描述输入框选择器');
        if (descEl) {
          descEl.focus();
          await sleep(300);
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          if (meta.description) {
            document.execCommand('insertText', false, meta.description);
            await sleep(300);
          }
          // 话题插入逻辑待适配视频号
        }
      }

      await postJSON('/progress', { task_id, progress: 85, msg: '视频号：信息已填写' });

      // Step 6: 点击发布
      // ⚠️ 待确认发布按钮选择器
      const publishBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        if (!btn.offsetParent) return false;
        const t = (btn.innerText || '').trim();
        return t === '发表' || t === '发布' || t === '发送';
      });
      if (!publishBtn) throw new Error('未找到发布按钮');
      publishBtn.click();

      await postJSON('/progress', { task_id, progress: 90, msg: '视频号：已点击发布' });
      await dismissPopupsRounds(5, 1000);

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
