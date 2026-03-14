// background service worker

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((res, rej) =>
    chrome.debugger.attach({ tabId }, '1.3', () =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()
    )
  );
}

// 获取元素的视口坐标（用 getBoundingClientRect，兼容内层滚动容器）
async function getViewportCenter(tabId, nodeId) {
  const { object } = await sendCommand(tabId, 'DOM.resolveNode', { nodeId });
  const { result } = await sendCommand(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { var r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }',
    returnByValue: true,
  });
  await sendCommand(tabId, 'Runtime.releaseObject', { objectId: object.objectId });
  return { cx: result.value.x, cy: result.value.y };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── setFileInput: 向 DOM 中已存在的 file input 直接注入文件 ──────────────
  if (msg.type === 'setFileInput') {
    const tabId = sender.tab.id;
    const filePath = msg.filePath;
    const selector = msg.selector || 'input[type="file"]';

    (async () => {
      try {
        await attachDebugger(tabId);
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        let { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId, selector,
        });
        if (!nodeId) {
          ({ nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
            nodeId: root.nodeId, selector: 'input[type="file"]',
          }));
        }
        if (!nodeId) throw new Error('找不到 input[type=file]');
        await sendCommand(tabId, 'DOM.setFileInputFiles', { nodeId, files: [filePath] });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── interceptAndSetFile: 拦截 input.click()，把 input 挂到 DOM，再注入文件 ──
  // 原理：覆写页面内 HTMLInputElement.prototype.click，当 XHS 代码调用
  //       createElement('input').click() 时，我们把 input 追加到 body，
  //       再用 DOM.setFileInputFiles 注入文件（会触发 change 事件），最后清理。
  if (msg.type === 'interceptAndSetFile') {
    const tabId = sender.tab.id;
    const { filePath, clickSelector } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);

        // 1. 注入 click 拦截器到页面 JS 上下文
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `(function(){
            if (window.__auInputHooked) return;
            window.__auInputHooked = true;
            window.__auCapturedInputId = null;
            const orig = HTMLInputElement.prototype.click;
            window.__auOrigClick = orig;
            HTMLInputElement.prototype.click = function() {
              if (this.type === 'file') {
                const id = '__xhs_cap_' + Date.now();
                this.id = id;
                this.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
                document.body.appendChild(this);
                window.__auCapturedInputId = id;
                return;
              }
              return orig.call(this);
            };
          })()`,
          awaitPromise: false,
        });

        // 2. 鼠标事件点击触发按钮
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId: btnId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId, selector: clickSelector,
        });
        if (!btnId) throw new Error(`找不到元素: ${clickSelector}`);

        const { cx, cy } = await getViewportCenter(tabId, btnId);
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        });

        // 3. 轮询等待 input 被捕获（最多 3s）
        let capturedId = null;
        for (let i = 0; i < 15; i++) {
          const { result } = await sendCommand(tabId, 'Runtime.evaluate', {
            expression: 'window.__auCapturedInputId || ""',
          });
          if (result && result.value) { capturedId = result.value; break; }
          await new Promise(r => setTimeout(r, 200));
        }
        if (!capturedId) throw new Error('未拦截到 file input');

        // 4. DOM.setFileInputFiles 注入文件（自动触发 change 事件）
        const { root: root2 } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId: inputId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root2.nodeId, selector: `#${capturedId}`,
        });
        if (!inputId) throw new Error('captured input 不在 DOM');
        await sendCommand(tabId, 'DOM.setFileInputFiles', { nodeId: inputId, files: [filePath] });

        // 5. 清理
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `(function(){
            HTMLInputElement.prototype.click = window.__auOrigClick;
            delete window.__auInputHooked;
            delete window.__auOrigClick;
            delete window.__auCapturedInputId;
            var el = document.getElementById(${JSON.stringify(capturedId)});
            if (el) el.remove();
          })()`,
        });

        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── setFileViaChooser: 拦截文件选择对话框并注入文件 ──────────────────────
  if (msg.type === 'setFileViaChooser') {
    const tabId = sender.tab.id;
    const { filePath, clickSelector } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);

        // 必须先 enable Page domain
        await sendCommand(tabId, 'Page.enable', {});

        // 开启文件选择器拦截
        await sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });

        // 先注册事件监听，再点击（避免事件在监听前就触发）
        const fileChooserOpened = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(handler);
            reject(new Error('等待文件选择器超时(6s)'));
          }, 6000);

          function handler(source, method) {
            if (source.tabId !== tabId) return;
            if (method === 'Page.fileChooserOpened') {
              clearTimeout(timer);
              chrome.debugger.onEvent.removeListener(handler);
              resolve();
            }
          }
          chrome.debugger.onEvent.addListener(handler);
        });

        // 用 Input.dispatchMouseEvent 模拟真实点击（比 element.click() 更可靠）
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector: clickSelector,
        });
        if (!nodeId) throw new Error(`找不到元素: ${clickSelector}`);

        const { cx, cy } = await getViewportCenter(tabId, nodeId);

        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        });

        // 等文件选择器打开
        await fileChooserOpened;

        // 提供文件
        await sendCommand(tabId, 'Page.handleFileChooserDialog', {
          action: 'accept',
          files: [filePath],
        });

        await sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true });
      } catch (e) {
        try { await sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch (_) {}
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── cdpClick: 用 CDP 鼠标事件真实点击某个选择器元素 ──────────────────────
  if (msg.type === 'cdpClick') {
    const tabId = sender.tab.id;
    const { selector } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId, selector,
        });
        if (!nodeId) throw new Error(`找不到: ${selector}`);
        const { cx, cy } = await getViewportCenter(tabId, nodeId);
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true, x: cx, y: cy });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── cdpHover: 用 CDP 模拟鼠标悬停某个选择器元素 ─────────────────────────
  if (msg.type === 'cdpHover') {
    const tabId = sender.tab.id;
    const { selector } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId, selector,
        });
        if (!nodeId) throw new Error(`找不到: ${selector}`);
        const { cx, cy } = await getViewportCenter(tabId, nodeId);
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true, x: cx, y: cy });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── cdpFillInput: 点击 input 后全选再用键盘输入值 ────────────────────────
  if (msg.type === 'cdpFillInput') {
    const tabId = sender.tab.id;
    const { selector, value } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 1 });
        const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`找不到: ${selector}`);

        const { cx, cy } = await getViewportCenter(tabId, nodeId);

        // 三击全选（Mac/Win 通用），再插入文本
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 3 });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 3 });

        // 插入文本（替换选中内容）
        await sendCommand(tabId, 'Input.insertText', { text: value });

        // Enter 确认
        await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── setInputValue: 用 JS nativeSetter 直接设置 input 值并触发 Vue 事件 ──
  if (msg.type === 'setInputValue') {
    const tabId = sender.tab.id;
    const { selector, value } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `(function(){
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'not_found';
            el.removeAttribute('readonly');
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
            return 'ok';
          })()`,
          awaitPromise: false,
        });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // closeTab: 已禁用
  if (msg.type === 'closeTab') {
    return false;
  }

  return false;
});
