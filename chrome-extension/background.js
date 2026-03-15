// background service worker

// SPA 导航后自动重新注入 content.js
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {  // 只处理顶层 frame
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, allFrames: false },
      files: ['content.js'],
    }).catch(() => {});
  }
}, {
  url: [
    { hostContains: 'channels.weixin.qq.com' },
    { hostContains: 'creator.xiaohongshu.com' },
  ]
});

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

  // ── setFileInput: 向 DOM 中已存在的 file input 直接注入文件（支持 iframe）──
  // ── reinject: 重新注入 content.js（SPA 导航后需要）─────────────────────
  if (msg.type === 'reinject') {
    const tabId = sender.tab.id;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    }, () => {
      sendResponse({ ok: !chrome.runtime.lastError });
    });
    return true;
  }

  // 用 Runtime.evaluate 拿到元素的 objectId，再用 DOM.setFileInputFiles(objectId) 注入
  // 这样完全绕开跨 iframe 的 nodeId 问题
  if (msg.type === 'setFileInput') {
    const tabId = sender.tab.id;
    const filePath = msg.filePath;
    const selector = msg.selector || 'input[type="file"]';

    (async () => {
      try {
        await attachDebugger(tabId);
        const expr = `(function(sel) {
          var el = document.querySelector(sel);
          if (el) return el;
          var frames = document.querySelectorAll('iframe');
          for (var i = 0; i < frames.length; i++) {
            try {
              el = frames[i].contentDocument && frames[i].contentDocument.querySelector(sel);
              if (el) return el;
            } catch(e) {}
          }
          return null;
        })(${JSON.stringify(selector)})`;
        const { result: obj } = await sendCommand(tabId, 'Runtime.evaluate', {
          expression: expr, returnByValue: false,
        });
        if (!obj || !obj.objectId) throw new Error('找不到元素: ' + selector);
        // DOM.setFileInputFiles 支持直接传 objectId，无需 nodeId
        await sendCommand(tabId, 'DOM.setFileInputFiles', { objectId: obj.objectId, files: [filePath] });
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

          function handler(source, method, params) {
            if (source.tabId !== tabId) return;
            if (method === 'Page.fileChooserOpened') {
              clearTimeout(timer);
              chrome.debugger.onEvent.removeListener(handler);
              resolve(params);  // params 包含 backendNodeId
            }
          }
          chrome.debugger.onEvent.addListener(handler);
        });

        // 用 Runtime.evaluate 在主文档及同源 iframe 中找可见元素并计算视口坐标
        // 再用 Input.dispatchMouseEvent 模拟真实点击（支持 iframe 内元素）
        const { result: coordResult } = await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `(function(sel) {
            function findEl(doc, offsetX, offsetY) {
              var els = doc.querySelectorAll(sel);
              for (var j = 0; j < els.length; j++) {
                var r = els[j].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return { x: r.left + r.width / 2 + offsetX, y: r.top + r.height / 2 + offsetY };
                }
              }
              return null;
            }
            var pos = findEl(document, 0, 0);
            if (pos) return pos;
            var frames = document.querySelectorAll('iframe');
            for (var i = 0; i < frames.length; i++) {
              try {
                var fr = frames[i];
                var fRect = fr.getBoundingClientRect();
                pos = findEl(fr.contentDocument, fRect.left, fRect.top);
                if (pos) return pos;
              } catch(e) {}
            }
            return null;
          })(${JSON.stringify(clickSelector)})`,
          returnByValue: true,
        });
        if (!coordResult || !coordResult.value) throw new Error(`找不到元素: ${clickSelector}`);
        const { x: cx, y: cy } = coordResult.value;

        await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        });

        // 等文件选择器打开，拿到 backendNodeId
        const chooserParams = await fileChooserOpened;

        // 用 DOM.setFileInputFiles 直接注入文件（通过 backendNodeId）
        await sendCommand(tabId, 'DOM.setFileInputFiles', {
          files: [filePath],
          backendNodeId: chooserParams.backendNodeId,
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

  // ── runInPage: 在页面 JS 上下文执行表达式（可访问 iframe.contentDocument）──
  if (msg.type === 'runInPage') {
    const tabId = sender.tab.id;
    const { expression } = msg;
    (async () => {
      try {
        await attachDebugger(tabId);
        const { result, exceptionDetails } = await sendCommand(tabId, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: false,
        });
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        if (exceptionDetails) {
          sendResponse({ ok: false, error: exceptionDetails.text || 'JS exception' });
        } else {
          sendResponse({ ok: true, result: result?.value });
        }
      } catch (e) {
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

  // ── cdpClickIframe: 用 CDP 真实点击 iframe 内的元素 ─────────────────────
  if (msg.type === 'cdpClickIframe') {
    const tabId = sender.tab.id;
    const { selector } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        const { result: coordResult } = await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `(function(sel) {
            function findEl(doc, offsetX, offsetY) {
              var els = doc.querySelectorAll(sel);
              for (var j = 0; j < els.length; j++) {
                var r = els[j].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return { x: r.left + r.width / 2 + offsetX, y: r.top + r.height / 2 + offsetY };
                }
              }
              return null;
            }
            var pos = findEl(document, 0, 0);
            if (pos) return pos;
            var frames = document.querySelectorAll('iframe');
            for (var i = 0; i < frames.length; i++) {
              try {
                var fr = frames[i];
                var fRect = fr.getBoundingClientRect();
                pos = findEl(fr.contentDocument, fRect.left, fRect.top);
                if (pos) return pos;
              } catch(e) {}
            }
            return null;
          })(${JSON.stringify(selector)})`,
          returnByValue: true,
        });
        if (!coordResult || !coordResult.value) throw new Error(`找不到可见元素: ${selector}`);
        const { x: cx, y: cy } = coordResult.value;
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

  // ── cdpDrag: 用 CDP 模拟拖拽 ─────────────────────────────────────────────
  if (msg.type === 'cdpDrag') {
    const tabId = sender.tab.id;
    const { startX, startY, endX, endY } = msg;

    (async () => {
      try {
        await attachDebugger(tabId);
        // mousedown
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1,
        });
        // 分步 mousemove（平滑拖拽）
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const x = startX + (endX - startX) * i / steps;
          const y = startY + (endY - startY) * i / steps;
          await sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y, button: 'left',
          });
          await new Promise(r => setTimeout(r, 30));
        }
        // mouseup
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1,
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

  // ── captureScreenshot: CDP 截图，自动遍历所有帧找 .qrcode-area 裁剪 ───────
  if (msg.type === 'captureScreenshot') {
    const tabId = sender.tab.id;
    (async () => {
      try {
        await attachDebugger(tabId);
        await sendCommand(tabId, 'Page.enable', {});

        // clip 由 content.js 提供（主帧坐标），直接使用
        let clip;
        if (msg.clip) {
          const { x, y, width, height } = msg.clip;
          if (width > 0 && height > 0) clip = { x, y, width, height, scale: 1 };
        }

        const screenshotParams = { format: 'png' };
        if (clip) screenshotParams.clip = clip;
        const result = await sendCommand(tabId, 'Page.captureScreenshot', screenshotParams);
        await new Promise(res => chrome.debugger.detach({ tabId }, res));
        sendResponse({ ok: true, dataUrl: 'data:image/png;base64,' + result.data });
      } catch (e) {
        chrome.debugger.detach({ tabId }, () => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // closeTab: 操作完成后关闭当前标签页
  if (msg.type === 'closeTab') {
    if (sender.tab && sender.tab.id) {
      chrome.tabs.remove(sender.tab.id);
    }
    return false;
  }

  return false;
});
