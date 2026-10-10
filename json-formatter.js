// ===== 全局状态 =====
let currentData = null;       // 当前解析成功的数据
let currentType = null;       // 'json' | 'xml'
let fixedContent = null;      // 智能修复后的内容
const inputArea = document.getElementById('inputArea');
const mainContent = document.querySelector('.main-content');
const inputPanel = document.querySelector('.input-panel');
const outputPanel = document.querySelector('.output-panel');
const panelDivider = document.getElementById('panelDivider');
const PANEL_MIN_WIDTH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-min-width'), 10) || 280;

// ===== 初始化事件 =====
inputArea.addEventListener('input', () => {
    processingRevision++; cancelJsonTasks(); invalidateOutput(true); closeErrorPanel();
});
inputArea.addEventListener('input', debounce(onInputChange, 300));
inputArea.addEventListener('scroll', syncLineNumbers);
inputArea.addEventListener('keydown', handleTabKey);
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); doFormat(); }
});
initPanelResize();

// ===== 工具函数 =====
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    clearTimeout(toastTimer);
    t.classList.add('hidden');
    // 强制重排以重置动画
    void t.offsetWidth;
    t.textContent = msg;
    t.classList.remove('hidden');
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2000);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('✓ 已复制到剪贴板');
    } catch (e) {
        showToast('复制失败，请选中结果后手动复制');
    }
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isStructuredString(value) {
    return typeof value === 'string' && /^[\[{]/.test(value.trim());
}

function decodeSingleQuotedString(raw) {
    const text = raw.trim();
    if (text.length < 2 || text[0] !== '\'' || text[text.length - 1] !== '\'') return null;
    let decoded = '';
    for (let i = 1; i < text.length - 1; i++) {
        const ch = text[i];
        if (ch !== '\\') {
            decoded += ch;
            continue;
        }
        const next = text[i + 1];
        if (next === undefined) {
            decoded += '\\';
            continue;
        }
        i++;
        if (next === 'n') decoded += '\n';
        else if (next === 'r') decoded += '\r';
        else if (next === 't') decoded += '\t';
        else if (next === '\'' || next === '"' || next === '\\') decoded += next;
        else decoded += `\\${next}`;
    }
    return decoded;
}

function getStructuredFixCandidate(raw) {
    try {
        const parsed = unwrapStructuredJsonString(raw);
        return parsed.wasUnwrapped ? stringifyLosslessJson(parsed.value, null, 2) : null;
    } catch (e) {
        const decoded = decodeSingleQuotedString(raw);
        return isStructuredString(decoded) ? decoded.trim() : null;
    }
}

// Large JSON is parsed and serialized off the UI thread when Worker is available.
const LARGE_JSON_SIZE = 256 * 1024;
const MAX_INPUT_SIZE = 10 * 1024 * 1024;
let processingRevision = 0;
let jsonWorker = null, workerId = 0;
const workerRequests = new Map();
function cancelJsonTasks() {
    if (jsonWorker) jsonWorker.terminate();
    jsonWorker = null;
    for (const task of workerRequests.values()) task.reject(new Error('操作已取消'));
    workerRequests.clear();
    document.getElementById('processingStatus').textContent = '';
}
function runJsonTask(raw, indent = 2, sort = false, returnData = true) {
    if (!jsonWorker) {
        try {
            if (typeof Worker === 'undefined' || location.protocol === 'file:') throw new Error('Worker unavailable');
            jsonWorker = new Worker('formatter-worker.js');
            const worker = jsonWorker;
            worker.onmessage = ({ data }) => {
                const task = workerRequests.get(data.id);
                if (!task) return;
                workerRequests.delete(data.id);
                if (data.error) task.reject(new Error(data.error));
                else task.resolve(data);
            };
            worker.onerror = () => {
                if (jsonWorker !== worker) return;
                for (const task of workerRequests.values()) task.reject(new Error('后台线程不可用，请重新操作或使用本地 HTTP 服务'));
                workerRequests.clear(); worker.terminate(); jsonWorker = null;
            };
        } catch (e) {
            const parsed = unwrapStructuredJsonString(raw);
            const value = sort ? sortObjectKeys(parsed.value) : parsed.value;
            return Promise.resolve({ value, text: stringifyLosslessJson(value, null, indent), numbers: [] });
        }
    }
    const id = ++workerId;
    return new Promise((resolve, reject) => {
        workerRequests.set(id, { resolve, reject });
        jsonWorker.postMessage({ id, raw, indent, sort, returnData });
    });
}
function restoreJsonNumbers(result) {
    let root = result.value;
    for (const path of result.numbers) {
        if (!path.length) { root = new JsonNumber(root.source); continue; }
        let parent = root;
        for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]];
        const key = path[path.length - 1];
        parent[key] = new JsonNumber(parent[key].source);
    }
    return root;
}
function setFormattedText(text, xml = false) {
    const code = document.getElementById('formattedCode');
    // Syntax highlighting creates many spans. Large results use plain text.
    if (text.length >= LARGE_JSON_SIZE) code.textContent = text;
    else if (xml) renderXmlOutput(text);
    else code.innerHTML = highlightJson(text);
}

// Large trees retain a full data index but only mount a viewport of rows.
let virtualTree = null;
const TREE_ROW_HEIGHT = 28;
function needsVirtualTree(value, xml = false) {
    let count = 0;
    const stack = xml ? Array.from(value.childNodes) : [value];
    while (stack.length) {
        const item = stack.pop();
        if (++count > 1000 || (xml ? item.nodeValue?.length > 8192 : typeof item === 'string' && item.length > 8192)) return true;
        if (xml) { for (const child of item.childNodes) stack.push(child); }
        else if (item && typeof item === 'object' && !(item instanceof JsonNumber)) {
            for (const key of Object.keys(item)) stack.push(item[key]);
        }
    }
    return false;
}
function resetVirtualTree() {
    virtualTree = null;
    document.getElementById('treeOutput').classList.remove('virtual-mode');
    document.getElementById('jsonTree').onscroll = null;
}
function mountVirtualTree(value, xml = false) {
    resetVirtualTree();
    const rows = [];
    const stack = xml ? Array.from(value.childNodes).reverse().map(node => ({ value: node, path: '/' + node.nodeName + '[1]', parent: -1, depth: 0, preserve: false })) :
        [{ value, path: '$', key: 'root', parent: -1, depth: 0 }];
    while (stack.length) {
        const item = stack.pop(), val = item.value;
        if (xml && val.nodeType === Node.TEXT_NODE && !item.preserve && !val.nodeValue.trim()) continue;
        const row = { ...item, id: rows.length, label: '', text: '', branch: false, type: '' };
        rows.push(row);
        if (!xml) {
            row.label = item.parent < 0 ? '$' : JSON.stringify(item.key);
            row.branch = val !== null && typeof val === 'object' && !(val instanceof JsonNumber);
            if (row.branch) {
                const keys = Object.keys(val), array = Array.isArray(val);
                row.text = array ? `Array[${keys.length}]` : `Object{${keys.length}}`;
                for (let i = keys.length - 1; i >= 0; i--) {
                    const key = keys[i];
                    stack.push({ value: val[key], key, parent: row.id, depth: row.depth + 1, path: item.path + (array ? `[${key}]` : `[${JSON.stringify(key)}]`) });
                }
            } else {
                row.text = stringifyLosslessJson(val);
                row.type = val instanceof JsonNumber || typeof val === 'number' ? 'json-number' : typeof val === 'string' ? 'json-string' : typeof val === 'boolean' ? 'json-bool' : 'json-null';
            }
        } else {
            const element = val.nodeType === Node.ELEMENT_NODE;
            const space = element ? val.getAttribute('xml:space') : null;
            const preserve = space === null ? item.preserve : space === 'preserve';
            row.label = element ? '<' + val.nodeName + '>' : val.nodeType === Node.TEXT_NODE ? '#text' : val.nodeType === Node.ATTRIBUTE_NODE ? '@' + val.name : val.nodeName;
            row.text = element ? '' : val.nodeValue || new XMLSerializer().serializeToString(val);
            row.type = 'xml-value';
            const children = Array.from(val.childNodes).filter(child => preserve || child.nodeType !== Node.TEXT_NODE || child.nodeValue.trim());
            const counts = new Map();
            const entries = children.map(child => {
                const name = child.nodeType === Node.TEXT_NODE ? 'text()' : child.nodeType === Node.COMMENT_NODE ? 'comment()' : child.nodeType === Node.CDATA_SECTION_NODE ? 'cdata()' : child.nodeName;
                const index = (counts.get(name) || 0) + 1; counts.set(name, index);
                return { value: child, path: item.path + '/' + name + '[' + index + ']', parent: row.id, depth: row.depth + 1, preserve };
            });
            if (element) entries.unshift(...Array.from(val.attributes).map(attr => ({ value: attr, path: item.path + '/@' + attr.name, parent: row.id, depth: row.depth + 1, preserve })));
            row.branch = entries.length > 0;
            for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i]);
        }
    }
    virtualTree = { rows, xml, collapsed: new Set(rows.filter(row => row.branch && row.depth > 0).map(row => row.id)), visible: [], matches: [], matchIndex: -1 };
    document.getElementById('treeOutput').classList.add('virtual-mode');
    const container = document.getElementById('jsonTree');
    container.scrollTop = 0;
    container.onscroll = () => paintVirtualTree();
    rebuildVirtualRows();
    if (document.getElementById('searchInput').value.trim()) searchVirtualTree();
    else clearSearch();
}
function rebuildVirtualRows() {
    if (!virtualTree) return;
    const { rows, collapsed } = virtualTree;
    const hidden = [];
    virtualTree.visible = rows.filter(row => {
        hidden[row.id] = row.parent >= 0 && (hidden[row.parent] || collapsed.has(row.parent));
        return !hidden[row.id];
    });
    paintVirtualTree();
}
function paintVirtualTree() {
    if (!virtualTree) return;
    const state = virtualTree, container = document.getElementById('jsonTree');
    const height = container.clientHeight || 560;
    container.scrollTop = Math.min(container.scrollTop, Math.max(0, state.visible.length * TREE_ROW_HEIGHT - height));
    const start = Math.max(0, Math.floor(container.scrollTop / TREE_ROW_HEIGHT) - 5);
    const end = Math.min(state.visible.length, start + Math.ceil(height / TREE_ROW_HEIGHT) + 12);
    const fragment = document.createDocumentFragment();
    const spacer = size => { const el = document.createElement('div'); el.style.height = size + 'px'; fragment.appendChild(el); };
    spacer(start * TREE_ROW_HEIGHT);
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    const active = state.matches[state.matchIndex];
    for (let i = start; i < end; i++) {
        const row = state.visible[i];
        const line = document.createElement('div');
        line.className = 'tree-line virtual-row';
        line.style.paddingLeft = (6 + Math.min(row.depth, 32) * 18) + 'px';
        const toggle = document.createElement(row.branch ? 'button' : 'span');
        toggle.className = 'tree-toggle';
        toggle.textContent = row.branch ? '▼' : '';
        if (row.branch) {
            toggle.classList.toggle('collapsed', state.collapsed.has(row.id));
            toggle.setAttribute('aria-expanded', String(!state.collapsed.has(row.id)));
            toggle.setAttribute('aria-label', '展开或折叠 ' + row.path);
            toggle.onclick = () => { if (!state.collapsed.delete(row.id)) state.collapsed.add(row.id); rebuildVirtualRows(); };
        }
        line.appendChild(toggle);
        const field = (text, type) => {
            const el = document.createElement('span');
            el.className = type === 'key' ? 'tree-key' + (state.xml ? ' xml-tag' : '') : 'tree-value ' + row.type;
            el.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text;
            el.dataset.path = row.path; el.dataset.searchType = type;
            el.title = type === 'key' ? row.path : text.length > 500 ? text.slice(0, 500) + '…（复制可获取完整内容）' : text;
            if (keyword && text.toLowerCase().includes(keyword)) el.classList.add(type === 'key' ? 'search-highlight' : 'search-highlight-value');
            if (active?.id === row.id && active.type === type) { el.classList.add('active'); line.classList.add('active-match'); }
            return el;
        };
        line.append(field(row.label, 'key'), field(row.text, 'value'));
        const copy = document.createElement('button'); copy.className = 'tree-copy-btn'; copy.textContent = '复制';
        copy.onclick = () => {
            const val = row.value;
            copyToClipboard(state.xml ? val.nodeType === Node.ELEMENT_NODE ? new XMLSerializer().serializeToString(val) : val.nodeValue || new XMLSerializer().serializeToString(val) : typeof val === 'string' ? val : stringifyLosslessJson(val, null, 2));
        };
        line.appendChild(copy); fragment.appendChild(line);
    }
    spacer(Math.max(0, state.visible.length - end) * TREE_ROW_HEIGHT);
    container.replaceChildren(fragment);
}
function searchVirtualTree() {
    const state = virtualTree;
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    state.matches = []; state.matchIndex = -1;
    if (keyword) for (const row of state.rows) {
        if (row.label.toLowerCase().includes(keyword)) state.matches.push({ id: row.id, type: 'key' });
        if (!row.branch && row.text.toLowerCase().includes(keyword)) state.matches.push({ id: row.id, type: 'value' });
    }
    if (state.matches.length) { state.matchIndex = 0; activateVirtualMatch(); }
    else {
        document.getElementById('searchCount').textContent = keyword ? '无匹配' : '';
        document.getElementById('searchPath').textContent = ''; paintVirtualTree();
    }
}
function activateVirtualMatch() {
    const state = virtualTree, match = state.matches[state.matchIndex];
    if (!match) return;
    const row = state.rows[match.id];
    let parent = row.parent;
    while (parent >= 0) { state.collapsed.delete(parent); parent = state.rows[parent].parent; }
    rebuildVirtualRows();
    const index = state.visible.findIndex(item => item.id === row.id);
    const container = document.getElementById('jsonTree');
    container.scrollTop = Math.max(0, index * TREE_ROW_HEIGHT - (container.clientHeight || 560) / 2);
    paintVirtualTree();
    document.getElementById('searchCount').textContent = `${state.matchIndex + 1}/${state.matches.length}`;
    document.getElementById('searchPath').textContent = `${match.type === 'value' ? '值' : '字段'}：${row.path}`;
}

// ===== 输入变化处理 =====
function onInputChange() {
    rememberInput();
    const revision = ++processingRevision;
    cancelJsonTasks();
    const raw = inputArea.value.trim();
    updateLineNumbers();
    updateStats();
    if (!raw) {
        clearOutput();
        return;
    }
    if (raw.length > MAX_INPUT_SIZE) {
        invalidateOutput();
        document.getElementById('errorPanel').classList.remove('hidden');
        document.getElementById('fixSuggestion').classList.add('hidden');
        document.getElementById('errorTitle').textContent = '内容过大';
        document.getElementById('errorMessage').textContent = '内容超过 10 MiB，请拆分后处理';
        return;
    }
    // 自动识别类型并处理
    const type = detectType(raw);
    const typeLabels = { json: 'JSON', xml: 'XML', tostring: 'Java对象', unknown: '未知' };
    document.getElementById('dataType').textContent = typeLabels[type] || '未知';
    currentType = type;
    document.getElementById('sortKeysButton').disabled = type !== 'json';

    if (type === 'json') {
        processJson(raw, revision);
    } else if (type === 'xml') {
        processXml(raw);
    } else if (type === 'tostring') {
        processToString(raw);
    } else {
        // 尝试作为 JSON 处理以获取错误信息
        processJson(raw);
    }
}

function detectType(s) {
    const t = s.trimStart();
    if (t.startsWith('<')) return 'xml';
    if (t.startsWith('{') || t.startsWith('[')) {
        // 优先尝试标准 JSON 解析
        // 检测 Java toString 格式：{key=value, key2=value2}
        if (/^\{[\s]*[\w.]+\s*=/.test(t)) return 'tostring';
        return 'json'; // 默认按 JSON 处理（可显示错误提示）
    }
    if (t.startsWith('"')) return 'json';
    try { JSON.parse(s); return 'json'; } catch (e) { }
    if (/<\w/.test(s)) return 'xml';
    return 'unknown';
}

// ===== 统计与行号 =====
function updateStats() {
    const v = inputArea.value;
    document.getElementById('charCount').textContent = v.length + ' 字符';
    document.getElementById('lineCount').textContent = v.split('\n').length + ' 行';
}

let numberedText = null, numberedLineCount = 1;
function updateLineNumbers() {
    if (numberedText !== inputArea.value) { numberedText = inputArea.value; numberedLineCount = numberedText.split('\n').length; }
    const count = numberedLineCount;
    const el = document.getElementById('lineNumbers');
    const start = Math.max(0, Math.floor(inputArea.scrollTop / 20.8) - 3);
    const end = Math.min(count, start + Math.ceil((inputArea.clientHeight || 600) / 20.8) + 8);
    el.innerHTML = `<div style="height:${start * 20.8}px"></div>` + Array.from({ length: Math.max(0, end - start) }, (_, i) => `<div>${start + i + 1}</div>`).join('') + `<div style="height:${Math.max(0, count - end) * 20.8}px"></div>`;
    el.scrollTop = inputArea.scrollTop;
}

function syncLineNumbers() { updateLineNumbers(); }

function handleTabKey(e) {
    if (e.key === 'Tab') {
        rememberInput();
        e.preventDefault();
        const s = inputArea.selectionStart, end = inputArea.selectionEnd;
        inputArea.value = inputArea.value.substring(0, s) + '  ' + inputArea.value.substring(end);
        inputArea.selectionStart = inputArea.selectionEnd = s + 2;
        onInputChange();
    }
}

// ===== JSON 处理 =====
async function processJson(raw, revision = processingRevision) {
    closeErrorPanel();
    try {
        let parsed;
        if (raw.length >= LARGE_JSON_SIZE) {
            invalidateOutput(true);
            document.getElementById('processingStatus').textContent = '后台处理中…';
            const result = await runJsonTask(raw);
            if (revision !== processingRevision || inputArea.value.trim() !== raw) return;
            parsed = { value: restoreJsonNumbers(result), text: result.text };
        } else parsed = formatStructuredJson(raw);
        currentData = parsed.value;
        document.getElementById('sortKeysButton').disabled = currentType !== 'json';
        setFormattedText(parsed.text);
        renderJsonTree(parsed.value);
        switchTab('tree');
    } catch (e) {
        if (revision !== processingRevision || inputArea.value.trim() !== raw) return;
        invalidateOutput(); showJsonError(raw, e);
    } finally {
        if (revision === processingRevision) document.getElementById('processingStatus').textContent = '';
    }
}

function renderFormattedJson(obj, indent = 2) {
    const formatted = stringifyLosslessJson(obj, null, indent);
    setFormattedText(formatted);
}

function highlightJson(str) {
    return str.replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        match => {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                cls = /:$/.test(match) ? 'json-key' : 'json-string';
            } else if (/true|false/.test(match)) {
                cls = 'json-bool';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return `<span class="${cls}">${escapeHtml(match)}</span>`;
        }
    );
}

// ===== JSON 树形视图 =====
function renderJsonTree(obj) {
    if (needsVirtualTree(obj)) { mountVirtualTree(obj); return; }
    resetVirtualTree();
    const container = document.getElementById('jsonTree');
    container.innerHTML = '';
    container.appendChild(buildTreeNode('root', obj, '$', true));
    if (document.getElementById('searchInput').value.trim()) onSearchInput();
    else clearSearch();
}

function buildTreeNode(key, value, parentPath, isRoot, parentIsArray = false) {
    const currentPath = isRoot ? '$' : parentIsArray ? `${parentPath}[${key}]` : `${parentPath}[${JSON.stringify(key)}]`;
    const node = document.createElement('div');
    node.className = 'tree-node';
    const line = document.createElement('div');
    line.className = 'tree-line';

    if (value !== null && typeof value === 'object' && !(value instanceof JsonNumber)) {
        const isArray = Array.isArray(value);
        const keys = Object.keys(value);
        const count = keys.length;

        // 折叠按钮
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle';
        toggle.textContent = '▼';
        toggle.onclick = () => {
            node.querySelector('.tree-children').classList.toggle('collapsed');
            toggle.classList.toggle('collapsed');
        };
        line.appendChild(toggle);

        // Key 标签
        if (!isRoot) {
            const keyEl = document.createElement('span');
            keyEl.className = 'tree-key';
            keyEl.dataset.path = currentPath;
            keyEl.dataset.searchType = 'key';
            keyEl.title = currentPath;
            keyEl.textContent = `"${key}": `;
            line.appendChild(keyEl);
        }

        // 类型标签
        const typeEl = document.createElement('span');
        typeEl.className = 'tree-type';
        typeEl.dataset.path = currentPath;
        typeEl.textContent = isArray ? `Array[${count}]` : `Object{${count}}`;
        line.appendChild(typeEl);

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'tree-copy-btn';
        copyBtn.textContent = '复制';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(stringifyLosslessJson(value, null, 2));
        };
        line.appendChild(copyBtn);

        node.appendChild(line);

        // 子节点容器
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children';
        keys.forEach(k => {
            childrenDiv.appendChild(buildTreeNode(k, value[k], currentPath, false, isArray));
        });
        node.appendChild(childrenDiv);
    } else {
        // 叶子节点
        const spacer = document.createElement('span');
        spacer.style.cssText = 'width:18px;display:inline-block;flex-shrink:0;';
        line.appendChild(spacer);

        const keyEl = document.createElement('span');
        keyEl.className = 'tree-key';
        keyEl.dataset.path = currentPath;
        keyEl.dataset.searchType = 'key';
        keyEl.title = currentPath;
        keyEl.textContent = `"${key}": `;
        line.appendChild(keyEl);

        const valEl = document.createElement('span');
        valEl.className = 'tree-value';
        valEl.dataset.path = currentPath;
        valEl.dataset.searchType = 'value';
        if (typeof value === 'string') {
            valEl.className += ' json-string';
            valEl.textContent = `"${value}"`;
        } else if (typeof value === 'number' || value instanceof JsonNumber) {
            valEl.className += ' json-number';
            valEl.textContent = value instanceof JsonNumber ? value.source : value;
        } else if (typeof value === 'boolean') {
            valEl.className += ' json-bool';
            valEl.textContent = value;
        } else {
            valEl.className += ' json-null';
            valEl.textContent = 'null';
        }
        line.appendChild(valEl);

        // 复制值按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'tree-copy-btn';
        copyBtn.textContent = '复制';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            const copyVal = typeof value === 'string' ? value : stringifyLosslessJson(value);
            copyToClipboard(copyVal);
        };
        line.appendChild(copyBtn);

        node.appendChild(line);
    }
    return node;
}

// ===== JSON 错误分析与智能修复 =====
function showJsonError(raw, error) {
    const panel = document.getElementById('errorPanel');
    const msgEl = document.getElementById('errorMessage');
    const fixEl = document.getElementById('fixSuggestion');
    document.getElementById('errorTitle').textContent = 'JSON 解析提示';
    panel.classList.remove('hidden');

    // 解析错误位置
    const errMsg = error.message;
    let position = -1;
    const posMatch = errMsg.match(/position\s+(\d+)/i) || errMsg.match(/column\s+(\d+)/i);
    if (posMatch) position = parseInt(posMatch[1]);

    // 计算行列号
    let lineNum = 1, colNum = 1;
    if (position >= 0) {
        for (let i = 0; i < Math.min(position, raw.length); i++) {
            if (raw[i] === '\n') { lineNum++; colNum = 1; } else colNum++;
        }
    }

    // 构建错误上下文
    const lines = raw.split('\n');
    const locationText = position >= 0 ? `第 ${lineNum} 行，第 ${colNum} 列附近` : '当前输入';
    let contextHtml = `<div class="error-summary">❌ ${locationText}存在 JSON 语法错误</div>`;
    contextHtml += `<div class="error-hint">${escapeHtml(errMsg)}</div>`;

    if (position >= 0 && lineNum <= lines.length) {
        const start = Math.max(0, lineNum - 3);
        const end = Math.min(lines.length, lineNum + 2);
        contextHtml += '<details class="error-details"><summary class="error-detail-toggle">查看错误上下文</summary><div class="error-context">';
        for (let i = start; i < end; i++) {
            const ln = i + 1;
            const isErr = ln === lineNum;
            const prefix = isErr ? '→ ' : '  ';
            const style = isErr ? 'color:var(--danger);font-weight:600;' : 'color:var(--text-muted);';
            contextHtml += `<div style="${style}"><span class="error-line-num">${String(ln).padStart(4)}</span> │ ${prefix}${escapeHtml(lines[i])}</div>`;
            if (isErr) {
                const pointer = ' '.repeat(6 + colNum + 2) + '^';
                contextHtml += `<div class="error-pointer" style="color:var(--danger);">${pointer} 错误位置 (第 ${lineNum} 行, 第 ${colNum} 列)</div>`;
            }
        }
        contextHtml += '</div></details>';
    }
    msgEl.innerHTML = contextHtml;

    // 尝试智能修复
    const fixed = tryAutoFix(raw);
    if (fixed) {
        fixedContent = fixed.result;
        fixEl.classList.remove('hidden');
        document.getElementById('diffView').innerHTML = renderDiff(raw, fixed.result, fixed.description);
    } else {
        fixedContent = null;
        fixEl.classList.add('hidden');
    }
}

// Repair syntax tokens only. String contents are never processed as code.
function tokenizeRepairJson(raw) {
    const tokens = [];
    let pos = 0;
    while (pos < raw.length) {
        const start = pos, ch = raw[pos];
        if (/\s/.test(ch)) { pos++; continue; }
        if (raw.startsWith('//', pos)) {
            const end = raw.indexOf('\n', pos + 2);
            pos = end < 0 ? raw.length : end;
            tokens.push({ type: 'comment', text: raw.slice(start, pos) }); continue;
        }
        if (raw.startsWith('/*', pos)) {
            const end = raw.indexOf('*/', pos + 2);
            if (end < 0) throw new Error('注释未闭合');
            pos = end + 2; tokens.push({ type: 'comment', text: raw.slice(start, pos) }); continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            pos++;
            let encoded = '"', closed = false;
            while (pos < raw.length) {
                const c = raw[pos++];
                if (c === quote) { closed = true; break; }
                if (c === '\\') {
                    const next = raw[pos++];
                    if (next === undefined) throw new Error('字符串未闭合');
                    encoded += quote === "'" && next === "'" ? "'" : '\\' + next;
                } else encoded += c === '"' ? '\\"' : c;
            }
            if (!closed) throw new Error('字符串未闭合');
            encoded += '"';
            // This also rejects unsupported escapes and literal control chars.
            JSON.parse(encoded);
            tokens.push({ type: 'string', text: quote === '"' ? raw.slice(start, pos) : encoded, single: quote === "'" });
            continue;
        }
        if ('{}[]:,'.includes(ch)) { tokens.push({ type: ch, text: ch }); pos++; continue; }
        const word = raw.slice(pos).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[\p{L}_$][\p{L}\p{N}_$-]*)/u);
        if (!word) throw new Error('无法安全修复此标记');
        pos += word[0].length;
        tokens.push({ type: /^-?\d/.test(word[0]) ? 'number' : 'word', text: word[0] });
    }
    return tokens;
}

function tryAutoFix(raw) {
    // Do not rewrite a document which is already valid.
    try { formatStructuredJson(raw); return null; } catch (e) { }
    const unwrapped = getStructuredFixCandidate(raw);
    if (unwrapped) {
        try { return { result: formatStructuredJson(unwrapped).text, description: '解包字符串化 JSON' }; } catch (e) { }
    }
    try {
        const source = tokenizeRepairJson(raw);
        const descriptions = new Set();
        if (source.some(token => token.type === 'comment')) descriptions.add('移除字符串外的注释');
        if (source.some(token => token.single)) descriptions.add('转换单引号字符串');
        const tokens = source.filter(token => token.type !== 'comment');
        tokens.forEach((token, index) => {
            if (token.type === 'word' && tokens[index + 1]?.type === ':') {
                token.type = 'string'; token.text = JSON.stringify(token.text);
                descriptions.add('为字段名补全双引号');
            }
        });
        const output = [], stack = [];
        for (const token of tokens) {
            const previous = output[output.length - 1];
            const endsValue = previous && (['string', 'number', '}', ']'].includes(previous.type) || previous.type === 'word' && /^(true|false|null)$/.test(previous.text));
            const startsValue = ['string', 'number', '{', '['].includes(token.type) || token.type === 'word' && /^(true|false|null)$/.test(token.text);
            if (endsValue && startsValue) { output.push({ type: ',', text: ',' }); descriptions.add('补全相邻值之间的逗号'); }
            if (token.type === '{' || token.type === '[') stack.push(token.type === '{' ? '}' : ']');
            if (token.type === '}' || token.type === ']') {
                if (stack.pop() !== token.type) return null;
                if (output[output.length - 1]?.type === ',') { output.pop(); descriptions.add('移除末尾逗号'); }
            }
            output.push(token);
        }
        if (stack.length) {
            if (output[output.length - 1]?.type === ',') output.pop();
            descriptions.add('补全缺失的闭合括号');
            while (stack.length) output.push({ text: stack.pop() });
        }
        const candidate = output.map(token => token.text).join(' ');
        if (!descriptions.size) return null;
        return { result: formatStructuredJson(candidate).text, description: Array.from(descriptions).join('；') };
    } catch (e) { return null; }
}

function renderDiff(original, fixed, description) {
    const oldLines = original.split('\n');
    const newLines = fixed.split('\n');
    let html = `<div style="margin-bottom:10px;color:var(--success);font-size:13px;">📝 ${escapeHtml(description)}</div>`;

    // 简化 diff：展示修复后的结果，标注修改的行
    const maxShow = 30;
    const oldSet = new Set(oldLines.map(l => l.trim()));

    html += '<div>';
    const showLines = newLines.slice(0, maxShow);
    showLines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!oldSet.has(trimmed) && trimmed) {
            html += `<div class="diff-line diff-add">+ ${escapeHtml(line)}</div>`;
        } else {
            html += `<div class="diff-line diff-ctx">  ${escapeHtml(line)}</div>`;
        }
    });
    if (newLines.length > maxShow) {
        html += `<div class="diff-line diff-ctx">  ... 共 ${newLines.length} 行 ...</div>`;
    }
    html += '</div>';
    return html;
}

function applyFix() {
    rememberInput();
    if (fixedContent) {
        if (!replaceEditorText(fixedContent)) return;
        showToast('✓ 已应用智能修复');
    }
}

function closeErrorPanel() {
    document.getElementById('errorPanel').classList.add('hidden');
}

// ===== XML 处理 =====
function processXml(raw) {
    closeErrorPanel();
    try {
        const doc = parseXmlDocument(raw);
        currentData = doc;
        setFormattedText(formatXmlFromDocument(doc, raw), true);
        renderXmlTree(doc);
        switchTab('tree');
    } catch (e) {
        invalidateOutput();
        showXmlError(raw, e.message);
    }
}

let xmlErrorSignature = null;
function parseXmlDocument(raw) {
    const parser = new DOMParser();
    if (!xmlErrorSignature) {
        const probe = parser.parseFromString('<', 'application/xml').getElementsByTagName('parsererror')[0];
        xmlErrorSignature = { namespace: probe?.namespaceURI, style: probe?.getAttribute('style') };
    }
    const doc = parser.parseFromString(raw, 'application/xml');
    const errorNode = Array.from(doc.getElementsByTagNameNS(xmlErrorSignature.namespace || '*', 'parsererror'))
        .find(node => node.getAttribute('style') === xmlErrorSignature.style);
    if (errorNode) throw new Error(errorNode.textContent);
    return doc;
}

// Tokenize the original source so entity references, DTDs, quotes and CDATA
// survive unchanged. DOM serialization cannot preserve all of these details.
function tokenizeXml(xml) {
    const tokens = [];
    let i = 0;
    while (i < xml.length) {
        const start = i;
        if (xml[i] !== '<') {
            const end = xml.indexOf('<', i);
            i = end === -1 ? xml.length : end;
        } else {
            const terminator = xml.startsWith('<!--', i) ? '-->' :
                xml.startsWith('<![CDATA[', i) ? ']]>' : xml.startsWith('<?', i) ? '?>' : null;
            if (terminator) {
                const end = xml.indexOf(terminator, i + 2);
                if (end === -1) throw new Error('XML 标记未闭合');
                i = end + terminator.length;
            } else {
                let quote = '', subsetDepth = 0;
                i++;
                while (i < xml.length) {
                    if (!quote && xml.startsWith('<!--', i)) {
                        const end = xml.indexOf('-->', i + 4);
                        if (end === -1) throw new Error('XML 注释未闭合');
                        i = end + 3;
                        continue;
                    }
                    const ch = xml[i++];
                    if (quote) { if (ch === quote) quote = ''; }
                    else if (ch === '"' || ch === "'") quote = ch;
                    else if (ch === '[') subsetDepth++;
                    else if (ch === ']') subsetDepth--;
                    else if (ch === '>' && subsetDepth === 0) break;
                }
            }
        }
        const text = xml.slice(start, i);
        const kind = text[0] !== '<' ? 'text' : text.startsWith('</') ? 'close' :
            text.startsWith('<!') || text.startsWith('<?') ? 'special' : 'open';
        tokens.push({ text, kind });
    }
    return tokens;
}

function formatXml(rawXml) {
    return formatXmlFromDocument(parseXmlDocument(rawXml), rawXml);
}

function formatXmlFromDocument(doc, rawXml, compact = false) {
    const root = { children: [], preserve: false };
    const stack = [root];
    for (const token of tokenizeXml(rawXml)) {
        const parent = stack[stack.length - 1];
        if (token.kind === 'open') {
            const space = token.text.match(/\sxml:space\s*=\s*(["'])(.*?)\1/);
            const item = { ...token, children: [], preserve: space ? space[2] === 'preserve' : parent.preserve };
            parent.children.push(item);
            if (!/\/\s*>$/.test(token.text)) stack.push(item);
        } else if (token.kind === 'close') {
            stack.pop().closing = token.text;
        } else parent.children.push(token);
    }
    function serialize(item, depth) {
        if (!item.children) return item.text;
        if (item.text && !item.closing) return item.text;
        // Preserve entire mixed-content subtrees: even whitespace-only text
        // between inline elements can be part of the document's content.
        const mixed = item.preserve || item.children.some(child =>
            child.kind === 'text' && child.text.trim() || child.text?.startsWith('<![CDATA['));
        if (mixed) return (item.text || '') + item.children.map(original).join('') + (item.closing || '');
        const children = item.children.filter(child => child.kind !== 'text' || child.text.trim());
        if (!children.length) return (item.text || '') + (item.closing || '');
        const separator = compact ? '' : '\n';
        const body = children.map(child => (compact ? '' : '  '.repeat(item.text ? depth + 1 : depth)) +
            serialize(child, item.text ? depth + 1 : depth)).join(separator);
        return item.text ? item.text + separator + body + separator + (compact ? '' : '  '.repeat(depth)) + item.closing : body;
    }
    function original(item) {
        return item.text + (item.children ? item.children.map(original).join('') : '') + (item.closing || '');
    }
    return serialize(root, 0);
}

function minifyXml(raw) {
    return formatXmlFromDocument(parseXmlDocument(raw), raw, true);
}

function renderXmlTree(doc) {
    if (needsVirtualTree(doc, true)) { mountVirtualTree(doc, true); return; }
    resetVirtualTree();
    const container = document.getElementById('jsonTree');
    container.replaceChildren();
    function build(node, path, inheritedPreserve = false) {
        const element = node.nodeType === Node.ELEMENT_NODE;
        const space = element ? node.getAttribute('xml:space') : null;
        const preserve = space === null ? inheritedPreserve : space === 'preserve';
        const children = Array.from(node.childNodes).filter(child =>
            preserve || child.nodeType !== Node.TEXT_NODE || child.nodeValue.trim());
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node xml-tree-node';
        const line = document.createElement('div');
        line.className = 'tree-line';
        wrapper.appendChild(line);
        const toggle = document.createElement(children.length || element && node.attributes.length ? 'button' : 'span');
        toggle.className = 'tree-toggle';
        toggle.textContent = toggle.tagName === 'BUTTON' ? '▼' : '';
        line.appendChild(toggle);
        function field(text, value, fieldPath) {
            const span = document.createElement('span');
            span.className = value ? 'tree-value xml-value' : 'tree-key xml-tag';
            span.textContent = text;
            span.dataset.path = fieldPath;
            span.dataset.searchType = value ? 'value' : 'key';
            span.title = fieldPath;
            return span;
        }
        const label = element ? '<' + node.nodeName + '>' :
            node.nodeType === Node.TEXT_NODE ? '#text' : node.nodeType === Node.CDATA_SECTION_NODE ? 'CDATA' :
            node.nodeType === Node.COMMENT_NODE ? '#comment' : node.nodeName;
        line.appendChild(field(label, false, path));
        if (!element) line.appendChild(field(node.nodeValue || new XMLSerializer().serializeToString(node), true, path));
        const copy = document.createElement('button');
        copy.className = 'tree-copy-btn';
        copy.textContent = '复制';
        copy.title = element ? '复制 XML 子树（含命名空间）' : '复制节点内容';
        copy.onclick = () => copyToClipboard(element ? new XMLSerializer().serializeToString(node) : node.nodeValue || new XMLSerializer().serializeToString(node));
        line.appendChild(copy);
        if (toggle.tagName === 'BUTTON') {
            const body = document.createElement('div');
            body.className = 'tree-children';
            toggle.setAttribute('aria-expanded', 'true');
            toggle.setAttribute('aria-label', '展开或折叠 ' + path);
            toggle.onclick = () => {
                const collapsed = body.classList.toggle('collapsed');
                toggle.classList.toggle('collapsed', collapsed);
                toggle.setAttribute('aria-expanded', String(!collapsed));
            };
            if (element) for (const attr of node.attributes) {
                const row = document.createElement('div');
                row.className = 'tree-node tree-line';
                row.append(field('@' + attr.name, false, path + '/@' + attr.name), field(attr.value, true, path + '/@' + attr.name));
                const attrCopy = document.createElement('button');
                attrCopy.className = 'tree-copy-btn';
                attrCopy.textContent = '复制';
                attrCopy.title = '复制属性值';
                attrCopy.onclick = () => copyToClipboard(attr.value);
                row.appendChild(attrCopy);
                body.appendChild(row);
            }
            const counts = new Map();
            children.forEach(child => {
                const name = child.nodeType === Node.ELEMENT_NODE ? child.nodeName :
                    child.nodeType === Node.TEXT_NODE ? 'text()' : child.nodeType === Node.COMMENT_NODE ? 'comment()' : child.nodeType === Node.CDATA_SECTION_NODE ? 'cdata()' : child.nodeName;
                const index = (counts.get(name) || 0) + 1;
                counts.set(name, index);
                body.appendChild(build(child, path + '/' + name + '[' + index + ']', preserve));
            });
            wrapper.appendChild(body);
        }
        return wrapper;
    }
    for (const child of doc.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim()) continue;
        container.appendChild(build(child, '/' + child.nodeName + '[1]'));
    }
    if (document.getElementById('searchInput').value.trim()) onSearchInput();
    else clearSearch();
}

function invalidateOutput(preserveQuery = false) {
    const query = preserveQuery ? document.getElementById('searchInput').value : '';
    resetVirtualTree();
    document.getElementById('sortKeysButton').disabled = true;
    currentData = null;
    fixedContent = null;
    document.getElementById('formattedCode').replaceChildren();
    document.getElementById('jsonTree').replaceChildren();
    clearSearch();
    if (preserveQuery) document.getElementById('searchInput').value = query;
}

function renderXmlOutput(xml) {
    const codeEl = document.getElementById('formattedCode');
    codeEl.textContent = '';
    codeEl.appendChild(buildXmlFragment(xml));
}

function buildXmlFragment(xml) {
    const fragment = document.createDocumentFragment();
    for (const token of tokenizeXml(xml)) {
        if (token.kind === 'text') fragment.appendChild(document.createTextNode(token.text));
        else appendXmlToken(fragment, token.text);
    }
    return fragment;
}

function appendXmlToken(fragment, token) {
    if (token.startsWith('<!--')) {
        appendXmlSpan(fragment, 'xml-comment', token);
        return;
    }
    if (token.startsWith('<![CDATA[')) {
        appendXmlSpan(fragment, 'xml-cdata', token);
        return;
    }
    if (token.startsWith('<!DOCTYPE')) {
        appendXmlSpan(fragment, 'xml-comment', token);
        return;
    }
    if (token.startsWith('<?')) {
        fragment.appendChild(document.createTextNode('<?'));
        const body = token.slice(2, -2).trim();
        const firstSpace = body.search(/\s/);
        const name = firstSpace === -1 ? body : body.slice(0, firstSpace);
        appendXmlSpan(fragment, 'xml-tag', name);
        if (firstSpace !== -1) fragment.appendChild(document.createTextNode(body.slice(firstSpace)));
        fragment.appendChild(document.createTextNode('?>'));
        return;
    }

    const isClosing = token.startsWith('</');
    const isSelfClosing = token.endsWith('/>');
    const inner = token.slice(isClosing ? 2 : 1, token.length - (isSelfClosing ? 2 : 1));
    const nameMatch = inner.match(/^([^\s/>]+)/);
    const tagName = nameMatch ? nameMatch[1] : inner.trim();
    const attrText = nameMatch ? inner.slice(tagName.length) : '';

    fragment.appendChild(document.createTextNode(isClosing ? '</' : '<'));
    appendXmlSpan(fragment, 'xml-tag', tagName);
    appendXmlAttributes(fragment, attrText);
    fragment.appendChild(document.createTextNode(isSelfClosing ? '/>' : '>'));
}

function appendXmlAttributes(fragment, attrText) {
    let lastIndex = 0;
    const attrRegex = /([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
    let match;
    while ((match = attrRegex.exec(attrText))) {
        if (match.index > lastIndex) fragment.appendChild(document.createTextNode(attrText.slice(lastIndex, match.index)));
        appendXmlSpan(fragment, 'xml-attr', match[1]);
        fragment.appendChild(document.createTextNode(match[2]));
        appendXmlSpan(fragment, 'xml-value', match[3]);
        lastIndex = attrRegex.lastIndex;
    }
    if (lastIndex < attrText.length) fragment.appendChild(document.createTextNode(attrText.slice(lastIndex)));
}

function appendXmlSpan(fragment, className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    fragment.appendChild(span);
}

function showXmlError(raw, errMsg) {
    invalidateOutput();
    const panel = document.getElementById('errorPanel');
    const msgEl = document.getElementById('errorMessage');
    document.getElementById('errorTitle').textContent = 'XML 解析提示';
    panel.classList.remove('hidden');
    document.getElementById('fixSuggestion').classList.add('hidden');
    msgEl.innerHTML = `<div class="error-summary">❌ XML 语法存在问题</div><div class="error-hint">${escapeHtml(errMsg)}</div>`;
}

// ===== Java toString() 格式处理 =====
// 解析 Java 对象的 toString() 输出，如 {key=value, key2={nested=val}}
function processToString(raw) {
    closeErrorPanel();
    try {
        const obj = parseJavaToString(raw);
        if (!obj || typeof obj !== 'object') {
            throw new Error('无法解析为有效的 Java toString 格式');
        }
        currentData = obj;
        // 转换为 JSON 格式展示
        const jsonStr = stringifyLosslessJson(obj, null, 2);
        document.getElementById('formattedCode').innerHTML = highlightJson(jsonStr);
        renderJsonTree(obj);
        switchTab('tree');
        showToast('✓ 已将 Java toString 格式转换为 JSON');
    } catch (e) {
        invalidateOutput();
        // 显示解析错误
        const panel = document.getElementById('errorPanel');
        const msgEl = document.getElementById('errorMessage');
        panel.classList.remove('hidden');
        document.getElementById('fixSuggestion').classList.add('hidden');
        msgEl.innerHTML = `<div style="color:var(--danger);font-weight:600;">❌ Java toString 格式解析错误</div><div style="margin-top:8px;">${escapeHtml(e.message)}</div>`;
    }
}

/**
 * 解析 Java 对象的 toString() 输出为 JavaScript 对象
 * 支持：嵌套对象 {}、空值、含 [...] 显示标签的值、数值/布尔自动转换、... 截断标记
 * @param {string} input - Java toString 格式字符串
 * @returns {object} 解析后的 JavaScript 对象
 */
function parseJavaToString(input) {
    input = input.trim();
    let pos = 0;

    // 跳过空白字符
    function skipWhitespace() {
        while (pos < input.length && /\s/.test(input[pos])) pos++;
    }

    // 解析一个对象 {...}
    function parseObject() {
        if (input[pos] !== '{') return null;
        pos++; // 跳过 '{'
        const obj = Object.create(null);

        while (pos < input.length) {
            skipWhitespace();
            if (pos >= input.length) break;
            if (input[pos] === '}') { pos++; return obj; }

            // 处理截断标记 '...'
            if (input.substring(pos, pos + 3) === '...') {
                pos += 3;
                skipWhitespace();
                // 跳到当前对象的闭合括号
                while (pos < input.length && input[pos] !== '}') pos++;
                if (pos < input.length) pos++;
                return obj;
            }

            // 读取 key（直到遇到 '='）
            let key = '';
            while (pos < input.length && input[pos] !== '=' && input[pos] !== '}') {
                key += input[pos];
                pos++;
            }
            key = key.trim();

            if (pos < input.length && input[pos] === '=') {
                pos++; // 跳过 '='
            } else {
                break; // 格式异常，终止
            }

            // 读取 value
            skipWhitespace();
            let value;
            if (pos < input.length && input[pos] === '{') {
                // 嵌套对象
                value = parseObject();
            } else {
                // 普通值（可能包含 [...] 显示标签、中文等）
                value = readPlainValue();
            }

            if (key) obj[key] = value;

            // 跳过分隔符 ', '
            skipWhitespace();
            if (pos < input.length && input[pos] === ',') {
                pos++;
                skipWhitespace();
            }
        }

        return obj;
    }

    /**
     * 读取一个普通值（非嵌套对象）
     * 通过前瞻判断逗号是键值对分隔符还是值的一部分：
     *   如果逗号后跟 word= 模式 → 分隔符
     *   否则 → 值的一部分
     */
    function readPlainValue() {
        let val = '';
        let braceDepth = 0;
        let bracketDepth = 0;

        while (pos < input.length) {
            const ch = input[pos];

            if (ch === '{') braceDepth++;
            if (ch === '}') {
                if (braceDepth === 0) break; // 到达父对象的闭合括号
                braceDepth--;
            }
            if (ch === '[') bracketDepth++;
            if (ch === ']') {
                if (bracketDepth > 0) bracketDepth--;
            }

            // 逗号分隔判断
            if (ch === ',' && braceDepth === 0 && bracketDepth <= 0) {
                const remaining = input.substring(pos + 1).trimStart();
                // 前瞻：逗号后面是否紧跟 key= 模式或结束标记
                if (/^[\w.]+\s*=/.test(remaining) || remaining.startsWith('}') || remaining.startsWith('...')) {
                    break; // 这是键值对分隔符
                }
            }

            val += ch;
            pos++;
        }

        val = val.trim();

        // 自动类型转换
        if (val === '') return '';
        if (val === 'null') return null;
        if (val === 'true') return true;
        if (val === 'false') return false;
        if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(val)) return parseLosslessJson(val);
        return val;
    }

    // 从顶层开始解析
    skipWhitespace();
    if (pos < input.length && input[pos] === '{') {
        return parseObject();
    }
    throw new Error('输入不是有效的 Java toString 格式（应以 { 开头）');
}

// ===== 工具栏操作 =====
function doFormat() {
    rememberInput();
    const raw = inputArea.value.trim();
    if (!raw) return;
    const type = detectType(raw);
    if (type === 'json' && raw.length >= LARGE_JSON_SIZE) { return performLargeJsonOperation(raw, 2); }
    if (type === 'json') {
        try {
            if (!replaceEditorText(formatStructuredJson(raw).text)) return;
            showToast('✓ JSON 格式化完成');
        } catch (e) { processJson(raw); }
    } else if (type === 'xml') {
        try {
            if (!replaceEditorText(formatXml(raw))) return;
            showToast('✓ XML 格式化完成');
        } catch (e) { showXmlError(raw, e.message); }
    } else if (type === 'tostring') {
        // 将 Java toString 格式转换为格式化的 JSON
        try {
            const obj = parseJavaToString(raw);
            if (!replaceEditorText(stringifyLosslessJson(obj, null, 2))) return;
            showToast('✓ 已转换为 JSON 格式');
        } catch (e) { processToString(raw); }
    }
}

function doMinify() {
    rememberInput();
    const raw = inputArea.value.trim();
    if (!raw) return;
    const type = detectType(raw);
    if (type === 'json' && raw.length >= LARGE_JSON_SIZE) { return performLargeJsonOperation(raw, 0); }
    if (type === 'json') {
        try {
            if (!replaceEditorText(formatStructuredJson(raw, 0).text)) return;
            showToast('✓ JSON 已压缩');
        } catch (e) { processJson(raw); }
    } else if (type === 'xml') {
        try {
            if (!replaceEditorText(minifyXml(raw))) return;
            showToast('✓ XML 已压缩');
        } catch (e) { showXmlError(raw, e.message); }
    } else if (type === 'tostring') {
        try {
            const obj = parseJavaToString(raw);
            if (!replaceEditorText(stringifyLosslessJson(obj))) return;
            showToast('✓ 已转换并压缩为 JSON');
        } catch (e) { processToString(raw); }
    }
}

function doSortKeys() {
    rememberInput();
    const raw = inputArea.value.trim();
    if (detectType(raw) !== 'json') { showToast('请先输入有效的 JSON'); return; }
    if (raw.length >= LARGE_JSON_SIZE) return performLargeJsonOperation(raw, 2, true);
    try {
        if (!replaceEditorText(stringifyLosslessJson(sortObjectKeys(formatStructuredJson(raw).value), null, 2))) return;
        showToast('✓ 已按 Key 字母排序');
    } catch (e) { invalidateOutput(); showJsonError(raw, e); }
}

function doCollapseAll() {
    // 自动切换到树形视图
    switchTab('tree');
    if (virtualTree) { virtualTree.collapsed = new Set(virtualTree.rows.filter(row => row.branch).map(row => row.id)); rebuildVirtualRows(); return; }
    document.querySelectorAll('#jsonTree .tree-children').forEach(el => el.classList.add('collapsed'));
    document.querySelectorAll('#jsonTree .tree-toggle').forEach(el => { el.classList.add('collapsed'); el.setAttribute('aria-expanded', 'false'); });
    showToast('✓ 已折叠全部节点');
}

function doExpandAll() {
    // 自动切换到树形视图
    switchTab('tree');
    if (virtualTree) { virtualTree.collapsed.clear(); rebuildVirtualRows(); return; }
    document.querySelectorAll('#jsonTree .tree-children').forEach(el => el.classList.remove('collapsed'));
    document.querySelectorAll('#jsonTree .tree-toggle').forEach(el => { el.classList.remove('collapsed'); el.setAttribute('aria-expanded', 'true'); });
    showToast('✓ 已展开全部节点');
}

function doCopyAll() {
    const code = document.getElementById('formattedCode').textContent;
    if (code) { copyToClipboard(code); }
    else { showToast('⚠️ 无内容可复制'); }
}

function doClear() {
    rememberInput();
    inputArea.value = '';
    onInputChange();
    clearOutput();
    closeErrorPanel();
    showToast('✓ 已清空');
}

function clearOutput() {
    resetVirtualTree();
    document.getElementById('formattedCode').innerHTML = '';
    document.getElementById('jsonTree').innerHTML = '';
    document.getElementById('dataType').textContent = '未检测';
    currentData = null; currentType = null;
    fixedContent = null;
    document.getElementById('sortKeysButton').disabled = true;
    clearSearch();
    closeErrorPanel();
    updateStats();
    updateLineNumbers();
}

// ===== Tab 切换 =====
function switchTab(tab) {
    if (virtualTree && tab === 'tree') paintVirtualTree();
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.output-content').forEach(el => el.classList.toggle('active', el.id === tab + 'Output'));
}

// ===== 加载示例 =====
function loadSample() {
    rememberInput();
    if (document.getElementById('sampleType').value === 'xml') {
        inputArea.value = `<?xml version="1.0" encoding="UTF-8"?>
<orders xmlns="urn:orders" xmlns:pay="urn:payment">
  <!-- 重复节点、属性、命名空间和混合文本示例 -->
  <order id="001"><customer>张三</customer><pay:amount currency="CNY">99.00</pay:amount></order>
  <order id="002"><note>请 <b>轻放</b> 包裹</note><payload><![CDATA[{"status":"ok"}]]></payload><empty/></order>
  <raw xml:space="preserve">  保留空格和换行
  原始文本  </raw>
</orders>`;
        onInputChange();
        showToast('✓ 已加载 XML 示例');
        return;
    }
    inputArea.value = JSON.stringify({
        "name": "张三",
        "age": 28,
        "department": "技术部",
        "skills": ["JavaScript", "Python", "Java"],
        "address": {
            "province": "安徽省",
            "city": "合肥市",
            "detail": {
                "street": "长江西路",
                "zipCode": "230000"
            }
        },
        "projects": [
            { "name": "工单系统", "status": "进行中", "priority": "高" },
            { "name": "数据平台", "status": "已完成", "priority": "中" }
        ],
        "isActive": true,
        "metadata": null
    }, null, 2);
    onInputChange();
    showToast('✓ 已加载示例数据');
}

// ===== 主题切换 =====
function toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    const newTheme = isLight ? 'dark' : 'light';
    html.setAttribute('data-theme', newTheme);
    try { localStorage.setItem('json-formatter-theme', newTheme); } catch (e) { /* 本地文件或隐私模式仍可切换主题 */ }
    // 切换图标
    document.getElementById('themeIconMoon').style.display = isLight ? '' : 'none';
    document.getElementById('themeIconSun').style.display = isLight ? 'none' : '';
    showToast(isLight ? '✓ 已切换为黑夜模式' : '✓ 已切换为白天模式');
}

// 页面加载时恢复主题
(function initTheme() {
    let saved;
    try { saved = localStorage.getItem('json-formatter-theme'); } catch (e) { return; }
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        document.getElementById('themeIconMoon').style.display = 'none';
        document.getElementById('themeIconSun').style.display = '';
    }
})();

// ===== 左右面板拖拽 =====
function initPanelResize() {
    if (!panelDivider || !mainContent || !inputPanel || !outputPanel) {
        console.warn('面板拖拽初始化失败：缺少必要的 DOM 节点');
        return;
    }
    panelDivider.addEventListener('pointerdown', startPanelResize);
    panelDivider.addEventListener('dblclick', resetPanelWidth);
    window.addEventListener('resize', clampPanelWidth);
}

function startPanelResize(e) {
    e.preventDefault();
    const rect = mainContent.getBoundingClientRect();
    const maxWidth = rect.width - PANEL_MIN_WIDTH;
    mainContent.classList.add('resizing');
    document.body.classList.add('is-resizing');

    const onMove = event => {
        const targetWidth = event.clientX - rect.left;
        const nextWidth = Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, targetWidth));
        inputPanel.style.flex = `0 0 ${nextWidth}px`;
        outputPanel.style.flex = '1 1 0';
    };

    const stop = () => {
        mainContent.classList.remove('resizing');
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop, { once: true });
}

function resetPanelWidth() {
    inputPanel.style.flex = '0 0 50%';
    outputPanel.style.flex = '1 1 0';
}

function clampPanelWidth() {
    if (!inputPanel.style.flexBasis) return;
    const rect = mainContent.getBoundingClientRect();
    const basis = inputPanel.style.flexBasis;
    const current = basis.endsWith('%')
        ? rect.width * parseFloat(basis) / 100
        : parseFloat(basis);
    if (!Number.isFinite(current)) return;
    const maxWidth = rect.width - PANEL_MIN_WIDTH;
    const clamped = Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, current));
    inputPanel.style.flex = `0 0 ${clamped}px`;
}

// ===== 树形视图搜索 =====
let searchMatches = [];   // 匹配到的 DOM 元素列表
let searchIndex = -1;     // 当前高亮的索引

function onSearchInput() {
    if (virtualTree) { searchVirtualTree(); return; }
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    // 清除上一次高亮
    clearSearchHighlights();

    if (!keyword) {
        document.getElementById('searchPath').textContent = '';
        document.getElementById('searchCount').textContent = '';
        searchMatches = [];
        searchIndex = -1;
        return;
    }

    // 在树形视图中查找所有匹配的 key / value 节点
    const allNodes = document.querySelectorAll('#jsonTree .tree-key, #jsonTree .tree-value');
    searchMatches = [];

    allNodes.forEach(el => {
        const text = el.textContent.replace(/"/g, '').replace(/:\s*$/, '').toLowerCase();
        if (text.includes(keyword)) {
            const searchType = getSearchType(el);
            el.classList.add(searchType === 'value' ? 'search-highlight-value' : 'search-highlight');
            searchMatches.push(el);
            // 自动展开所有父级折叠节点
            expandParents(el);
        }
    });

    // 更新计数
    const countEl = document.getElementById('searchCount');
    if (searchMatches.length > 0) {
        searchIndex = 0;
        activateSearchMatch(searchIndex);
        updateSearchInfo();
    } else {
        searchIndex = -1;
        countEl.textContent = '无匹配';
        document.getElementById('searchPath').textContent = '';
    }
}

function searchNext() {
    if (virtualTree) { if (virtualTree.matches.length) { virtualTree.matchIndex = (virtualTree.matchIndex + 1) % virtualTree.matches.length; activateVirtualMatch(); } return; }
    if (searchMatches.length === 0) return;
    searchIndex = (searchIndex + 1) % searchMatches.length;
    activateSearchMatch(searchIndex);
    updateSearchInfo();
}

function searchPrev() {
    if (virtualTree) { if (virtualTree.matches.length) { virtualTree.matchIndex = (virtualTree.matchIndex - 1 + virtualTree.matches.length) % virtualTree.matches.length; activateVirtualMatch(); } return; }
    if (searchMatches.length === 0) return;
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    activateSearchMatch(searchIndex);
    updateSearchInfo();
}

function activateSearchMatch(index) {
    searchMatches.forEach(el => {
        el.classList.remove('active');
        el.closest('.tree-line')?.classList.remove('active-match');
    });
    const target = searchMatches[index];
    if (!target) return;
    expandParents(target);
    target.classList.add('active');
    target.closest('.tree-line')?.classList.add('active-match');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 更新搜索计数和路径显示
function updateSearchInfo() {
    const active = searchMatches[searchIndex];
    if (!active) {
        document.getElementById('searchCount').textContent = searchMatches.length ? `0/${searchMatches.length}` : '';
        document.getElementById('searchPath').textContent = '';
        return;
    }
    document.getElementById('searchCount').textContent = `${searchIndex + 1}/${searchMatches.length}`;
    const path = active.dataset.path || '';
    const label = getSearchType(active) === 'value' ? '值' : '字段';
    document.getElementById('searchPath').textContent = path ? `${label}：${path}` : '';
}

function getSearchType(el) {
    return el?.dataset.searchType === 'value' ? 'value' : 'key';
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    if (virtualTree) { virtualTree.matches = []; virtualTree.matchIndex = -1; paintVirtualTree(); }
    document.getElementById('searchCount').textContent = '';
    document.getElementById('searchPath').textContent = '';
    clearSearchHighlights();
    searchMatches = [];
    searchIndex = -1;
}

function clearSearchHighlights() {
    document.querySelectorAll('#jsonTree .search-highlight, #jsonTree .search-highlight-value').forEach(el => {
        el.classList.remove('search-highlight', 'search-highlight-value', 'active');
        el.closest('.tree-line')?.classList.remove('active-match');
    });
}

// 向上遍历 DOM，展开所有折叠的父级节点
function expandParents(el) {
    let parent = el.closest('.tree-children');
    while (parent) {
        if (parent.classList.contains('collapsed')) {
            parent.classList.remove('collapsed');
            // 同步更新折叠箭头
            const toggle = parent.previousElementSibling?.querySelector('.tree-toggle');
            if (toggle) { toggle.classList.remove('collapsed'); toggle.setAttribute('aria-expanded', 'true'); }
        }
        parent = parent.parentElement?.closest('.tree-children');
    }
}

// Enter 键跳转下一个匹配
document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrev(); else searchNext();
    }
});

updateLineNumbers();
