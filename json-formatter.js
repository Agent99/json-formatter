// ===== 全局状态 =====
let currentData = null;       // 当前解析成功的数据
let currentType = null;       // 'json' | 'xml'
let fixedContent = null;      // 智能修复后的内容
const inputArea = document.getElementById('inputArea');

// ===== 初始化事件 =====
inputArea.addEventListener('input', debounce(onInputChange, 300));
inputArea.addEventListener('scroll', syncLineNumbers);
inputArea.addEventListener('keydown', handleTabKey);
document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); doFormat(); }
});
updateLineNumbers();

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

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => showToast('✓ 已复制到剪贴板'));
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 输入变化处理 =====
function onInputChange() {
    const raw = inputArea.value.trim();
    updateLineNumbers();
    updateStats();
    if (!raw) {
        clearOutput();
        return;
    }
    // 自动识别类型并处理
    const type = detectType(raw);
    document.getElementById('dataType').textContent = type === 'json' ? 'JSON' : type === 'xml' ? 'XML' : '未知';
    currentType = type;

    if (type === 'json') {
        processJson(raw);
    } else if (type === 'xml') {
        processXml(raw);
    } else {
        // 尝试作为 JSON 处理以获取错误信息
        processJson(raw);
    }
}

function detectType(s) {
    const t = s.trimStart();
    if (t.startsWith('<')) return 'xml';
    if (t.startsWith('{') || t.startsWith('[')) return 'json';
    // 尝试解析
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

function updateLineNumbers() {
    const lines = inputArea.value.split('\n');
    const el = document.getElementById('lineNumbers');
    el.innerHTML = lines.map((_, i) => `<div>${i + 1}</div>`).join('');
}

function syncLineNumbers() {
    document.getElementById('lineNumbers').scrollTop = inputArea.scrollTop;
}

function handleTabKey(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        const s = inputArea.selectionStart, end = inputArea.selectionEnd;
        inputArea.value = inputArea.value.substring(0, s) + '  ' + inputArea.value.substring(end);
        inputArea.selectionStart = inputArea.selectionEnd = s + 2;
        onInputChange();
    }
}

// ===== JSON 处理 =====
function processJson(raw) {
    closeErrorPanel();
    try {
        const obj = JSON.parse(raw);
        currentData = obj;
        renderFormattedJson(obj);
        renderJsonTree(obj);
        // JSON 自动切换到树形视图，让用户直接看到可交互的树
        switchTab('tree');
    } catch (e) {
        currentData = null;
        showJsonError(raw, e);
    }
}

function renderFormattedJson(obj, indent = 2) {
    const formatted = JSON.stringify(obj, null, indent);
    document.getElementById('formattedCode').innerHTML = highlightJson(formatted);
}

function highlightJson(str) {
    return escapeHtml(str).replace(
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
            return `<span class="${cls}">${match}</span>`;
        }
    );
}

// ===== JSON 树形视图 =====
function renderJsonTree(obj) {
    const container = document.getElementById('jsonTree');
    container.innerHTML = '';
    container.appendChild(buildTreeNode('root', obj, '$', true));
}

function buildTreeNode(key, value, parentPath, isRoot) {
    const currentPath = isRoot ? '$' : `${parentPath}.${key}`;
    const node = document.createElement('div');
    node.className = 'tree-node';
    const line = document.createElement('div');
    line.className = 'tree-line';

    if (value !== null && typeof value === 'object') {
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
            keyEl.title = currentPath;
            keyEl.textContent = `"${key}": `;
            line.appendChild(keyEl);
        }

        // 类型标签
        const typeEl = document.createElement('span');
        typeEl.className = 'tree-type';
        typeEl.textContent = isArray ? `Array[${count}]` : `Object{${count}}`;
        line.appendChild(typeEl);

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'tree-copy-btn';
        copyBtn.textContent = '复制';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(JSON.stringify(value, null, 2));
        };
        line.appendChild(copyBtn);

        node.appendChild(line);

        // 子节点容器
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children';
        keys.forEach(k => {
            childrenDiv.appendChild(buildTreeNode(k, value[k], currentPath, false));
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
        keyEl.title = currentPath;
        keyEl.textContent = `"${key}": `;
        line.appendChild(keyEl);

        const valEl = document.createElement('span');
        valEl.className = 'tree-value';
        if (typeof value === 'string') {
            valEl.className += ' json-string';
            valEl.textContent = `"${value}"`;
        } else if (typeof value === 'number') {
            valEl.className += ' json-number';
            valEl.textContent = value;
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
            const copyVal = typeof value === 'string' ? value : JSON.stringify(value);
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
    let contextHtml = `<div style="margin-bottom:12px;color:var(--danger);font-weight:600;">❌ ${escapeHtml(errMsg)}</div>`;

    if (position >= 0 && lineNum <= lines.length) {
        const start = Math.max(0, lineNum - 3);
        const end = Math.min(lines.length, lineNum + 2);
        contextHtml += '<div style="margin-top:8px;">';
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
        contextHtml += '</div>';
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

function tryAutoFix(raw) {
    const fixes = [
        { name: '移除尾部逗号', fn: s => s.replace(/,\s*([\]}])/g, '$1'), desc: '移除了对象/数组末尾多余的逗号' },
        { name: '单引号→双引号', fn: s => s.replace(/'/g, '"'), desc: '将单引号替换为标准的双引号' },
        { name: '补全缺失引号', fn: s => s.replace(/{\s*(\w+)\s*:/g, '{"$1":').replace(/,\s*(\w+)\s*:/g, ',"$1":'), desc: '为未加引号的 Key 添加了双引号' },
        { name: '移除注释', fn: s => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), desc: '移除了 JSON 中不允许的注释' },
        { name: '修复缺失逗号', fn: s => s.replace(/"\s*\n\s*"/g, '",\n"').replace(/}\s*\n\s*"/g, '},\n"').replace(/]\s*\n\s*"/g, '],\n"'), desc: '在相邻的元素之间补充了缺失的逗号' },
        {
            name: '补全括号', fn: s => {
                let open = 0, close = 0;
                for (const c of s) { if (c === '{') open++; if (c === '}') close++; }
                if (open > close) return s + '}'.repeat(open - close);
                open = 0; close = 0;
                for (const c of s) { if (c === '[') open++; if (c === ']') close++; }
                if (open > close) return s + ']'.repeat(open - close);
                return null;
            }, desc: '补全了缺失的闭合括号'
        },
    ];

    // 组合修复：先尝试单个修复，再尝试组合
    for (const fix of fixes) {
        const result = fix.fn(raw);
        if (result && result !== raw) {
            try {
                JSON.parse(result);
                return { result: JSON.stringify(JSON.parse(result), null, 2), description: fix.desc };
            } catch (e) { }
        }
    }

    // 尝试组合修复
    let combined = raw;
    const appliedFixes = [];
    for (const fix of fixes) {
        const r = fix.fn(combined);
        if (r && r !== combined) {
            combined = r;
            appliedFixes.push(fix.desc);
        }
    }
    if (combined !== raw) {
        try {
            JSON.parse(combined);
            return { result: JSON.stringify(JSON.parse(combined), null, 2), description: '组合修复：' + appliedFixes.join('；') };
        } catch (e) { }
    }
    return null;
}

function renderDiff(original, fixed, description) {
    const oldLines = original.split('\n');
    const newLines = fixed.split('\n');
    let html = `<div style="margin-bottom:10px;color:var(--success);font-size:13px;">📝 ${escapeHtml(description)}</div>`;

    // 简化 diff：展示修复后的结果，标注修改的行
    const maxShow = 30;
    const oldSet = new Set(oldLines.map(l => l.trim()));
    const newSet = new Set(newLines.map(l => l.trim()));

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
    if (fixedContent) {
        inputArea.value = fixedContent;
        onInputChange();
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
        const parser = new DOMParser();
        const doc = parser.parseFromString(raw, 'application/xml');
        const errorNode = doc.querySelector('parsererror');
        if (errorNode) {
            showXmlError(raw, errorNode.textContent);
            return;
        }
        currentData = raw;
        const formatted = formatXml(raw);
        document.getElementById('formattedCode').innerHTML = highlightXml(escapeHtml(formatted));
        // XML 不创建树形视图
        document.getElementById('jsonTree').innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">树形视图仅支持 JSON 格式</div>';
    } catch (e) {
        showXmlError(raw, e.message);
    }
}

function formatXml(xml) {
    let formatted = '';
    let indent = 0;
    const tab = '  ';
    // 移除现有缩进
    xml = xml.replace(/(>)\s*(<)/g, '$1\n$2');
    const lines = xml.split('\n');
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        if (line.match(/^<\/\w/)) indent--;
        formatted += tab.repeat(Math.max(0, indent)) + line + '\n';
        if (line.match(/^<\w[^>]*[^\/]>.*$/) && !line.match(/^<\w[^>]*>.*<\/\w/)) indent++;
    });
    return formatted.trim();
}

function highlightXml(str) {
    return str
        .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="xml-tag">$2</span>')
        .replace(/([\w:-]+)(=)(&quot;[^&]*&quot;)/g, '<span class="xml-attr">$1</span>$2<span class="xml-value">$3</span>');
}

function showXmlError(raw, errMsg) {
    const panel = document.getElementById('errorPanel');
    const msgEl = document.getElementById('errorMessage');
    panel.classList.remove('hidden');
    document.getElementById('fixSuggestion').classList.add('hidden');
    msgEl.innerHTML = `<div style="color:var(--danger);font-weight:600;">❌ XML 解析错误</div><div style="margin-top:8px;">${escapeHtml(errMsg)}</div>`;
}

// ===== 工具栏操作 =====
function doFormat() {
    const raw = inputArea.value.trim();
    if (!raw) return;
    const type = detectType(raw);
    if (type === 'json') {
        try {
            const obj = JSON.parse(raw);
            inputArea.value = JSON.stringify(obj, null, 2);
            onInputChange();
            showToast('✓ JSON 格式化完成');
        } catch (e) { processJson(raw); }
    } else if (type === 'xml') {
        inputArea.value = formatXml(raw);
        onInputChange();
        showToast('✓ XML 格式化完成');
    }
}

function doMinify() {
    const raw = inputArea.value.trim();
    if (!raw) return;
    const type = detectType(raw);
    if (type === 'json') {
        try {
            inputArea.value = JSON.stringify(JSON.parse(raw));
            onInputChange();
            showToast('✓ JSON 已压缩');
        } catch (e) { processJson(raw); }
    } else if (type === 'xml') {
        inputArea.value = raw.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
        onInputChange();
        showToast('✓ XML 已压缩');
    }
}

function doSortKeys() {
    if (!currentData || currentType !== 'json') {
        showToast('⚠️ 请先输入有效的 JSON');
        return;
    }
    const sorted = sortObjectKeys(currentData);
    inputArea.value = JSON.stringify(sorted, null, 2);
    onInputChange();
    showToast('✓ 已按 Key 字母排序');
}

function sortObjectKeys(obj) {
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    if (obj !== null && typeof obj === 'object') {
        return Object.keys(obj).sort((a, b) => a.localeCompare(b))
            .reduce((acc, key) => { acc[key] = sortObjectKeys(obj[key]); return acc; }, {});
    }
    return obj;
}

function doCollapseAll() {
    // 自动切换到树形视图
    switchTab('tree');
    document.querySelectorAll('#jsonTree .tree-children').forEach(el => el.classList.add('collapsed'));
    document.querySelectorAll('#jsonTree .tree-toggle').forEach(el => el.classList.add('collapsed'));
    showToast('✓ 已折叠全部节点');
}

function doExpandAll() {
    // 自动切换到树形视图
    switchTab('tree');
    document.querySelectorAll('#jsonTree .tree-children').forEach(el => el.classList.remove('collapsed'));
    document.querySelectorAll('#jsonTree .tree-toggle').forEach(el => el.classList.remove('collapsed'));
    showToast('✓ 已展开全部节点');
}

function doCopyAll() {
    const code = document.getElementById('formattedCode').textContent;
    if (code) { copyToClipboard(code); }
    else { showToast('⚠️ 无内容可复制'); }
}

function doClear() {
    inputArea.value = '';
    clearOutput();
    closeErrorPanel();
    showToast('✓ 已清空');
}

function clearOutput() {
    document.getElementById('formattedCode').innerHTML = '';
    document.getElementById('jsonTree').innerHTML = '';
    document.getElementById('dataType').textContent = '未检测';
    currentData = null; currentType = null;
    updateStats();
    updateLineNumbers();
}

// ===== Tab 切换 =====
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.output-content').forEach(el => el.classList.toggle('active', el.id === tab + 'Output'));
}

// ===== 加载示例 =====
function loadSample() {
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
    localStorage.setItem('json-formatter-theme', newTheme);
    // 切换图标
    document.getElementById('themeIconMoon').style.display = isLight ? '' : 'none';
    document.getElementById('themeIconSun').style.display = isLight ? 'none' : '';
    showToast(isLight ? '✓ 已切换为黑夜模式' : '✓ 已切换为白天模式');
}

// 页面加载时恢复主题
(function initTheme() {
    const saved = localStorage.getItem('json-formatter-theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        document.getElementById('themeIconMoon').style.display = 'none';
        document.getElementById('themeIconSun').style.display = '';
    }
})();

// ===== 树形视图搜索 =====
let searchMatches = [];   // 匹配到的 DOM 元素列表
let searchIndex = -1;     // 当前高亮的索引

function onSearchInput() {
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    // 清除上一次高亮
    clearSearchHighlights();

    if (!keyword) {
        document.getElementById('searchCount').textContent = '';
        searchMatches = [];
        searchIndex = -1;
        return;
    }

    // 在树形视图中查找所有匹配的 key 节点
    const allKeys = document.querySelectorAll('#jsonTree .tree-key');
    searchMatches = [];

    allKeys.forEach(el => {
        const text = el.textContent.replace(/"/g, '').replace(/:\s*$/, '').toLowerCase();
        if (text.includes(keyword)) {
            el.classList.add('search-highlight');
            searchMatches.push(el);
            // 自动展开所有父级折叠节点
            expandParents(el);
        }
    });

    // 更新计数
    const countEl = document.getElementById('searchCount');
    if (searchMatches.length > 0) {
        searchIndex = 0;
        searchMatches[0].classList.add('active');
        searchMatches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        updateSearchInfo();
    } else {
        searchIndex = -1;
        countEl.textContent = '无匹配';
        document.getElementById('searchPath').textContent = '';
    }
}

function searchNext() {
    if (searchMatches.length === 0) return;
    searchMatches[searchIndex].classList.remove('active');
    searchIndex = (searchIndex + 1) % searchMatches.length;
    searchMatches[searchIndex].classList.add('active');
    searchMatches[searchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSearchInfo();
}

function searchPrev() {
    if (searchMatches.length === 0) return;
    searchMatches[searchIndex].classList.remove('active');
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    searchMatches[searchIndex].classList.add('active');
    searchMatches[searchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSearchInfo();
}

// 更新搜索计数和路径显示
function updateSearchInfo() {
    document.getElementById('searchCount').textContent = `${searchIndex + 1}/${searchMatches.length}`;
    const path = searchMatches[searchIndex].dataset.path || '';
    document.getElementById('searchPath').textContent = path;
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchCount').textContent = '';
    document.getElementById('searchPath').textContent = '';
    clearSearchHighlights();
    searchMatches = [];
    searchIndex = -1;
}

function clearSearchHighlights() {
    document.querySelectorAll('#jsonTree .search-highlight').forEach(el => {
        el.classList.remove('search-highlight', 'active');
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
            if (toggle) toggle.classList.remove('collapsed');
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
