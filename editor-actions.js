// Text snapshots cover typing and toolbar changes without storing user data remotely.
const editorHistory = [{ text: '', start: 0, end: 0, scroll: 0, filename: '' }];
let historyIndex = 0, replayingHistory = false;
const HISTORY_LIMIT = 50, HISTORY_SIZE_LIMIT = 24 * 1024 * 1024;
let importedName = '', importVersion = 0;
function updateHistoryButtons() {
    const pendingEdit = inputArea.value !== editorHistory[historyIndex].text;
    document.getElementById('undoButton').disabled = historyIndex <= 0 && !pendingEdit;
    document.getElementById('redoButton').disabled = pendingEdit || historyIndex >= editorHistory.length - 1;
}
function rememberInput() {
    if (replayingHistory) return;
    const entry = { text: inputArea.value, start: inputArea.selectionStart, end: inputArea.selectionEnd, scroll: inputArea.scrollTop, filename: importedName };
    if (editorHistory[historyIndex].text === entry.text && editorHistory[historyIndex].filename === entry.filename) editorHistory[historyIndex] = entry;
    else {
        editorHistory.splice(historyIndex + 1);
        editorHistory.push(entry); historyIndex++;
        let size = editorHistory.reduce((sum, item) => sum + item.text.length, 0);
        while (editorHistory.length > 2 && (editorHistory.length > HISTORY_LIMIT || size > HISTORY_SIZE_LIMIT)) {
            size -= editorHistory.shift().text.length; historyIndex--;
        }
    }
    updateHistoryButtons();
}
function replaceEditorText(text, filename = importedName) {
    if (text.length > MAX_INPUT_SIZE) { showToast('结果超过长度上限，请压缩或下载输出'); return false; }
    rememberInput();
    importedName = filename;
    inputArea.value = text;
    inputArea.selectionStart = inputArea.selectionEnd = 0;
    inputArea.scrollTop = 0;
    onInputChange();
    return true;
}
function restoreHistory(index) {
    const entry = editorHistory[index];
    if (!entry) return;
    historyIndex = index; replayingHistory = true;
    inputArea.value = entry.text;
    importedName = entry.filename;
    onInputChange();
    inputArea.focus();
    inputArea.setSelectionRange(entry.start, entry.end); inputArea.scrollTop = entry.scroll;
    syncLineNumbers(); replayingHistory = false; updateHistoryButtons();
}
function doUndo() { rememberInput(); if (historyIndex > 0) restoreHistory(historyIndex - 1); }
function doRedo() { rememberInput(); if (historyIndex < editorHistory.length - 1) restoreHistory(historyIndex + 1); }

document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target !== inputArea && event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); event.shiftKey ? doRedo() : doUndo(); }
    else if (key === 'y') { event.preventDefault(); doRedo(); }
});
inputArea.addEventListener('input', updateHistoryButtons);
function selectImportFile() { document.getElementById('fileInput').click(); }
function readTextFile(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsText(file, 'UTF-8');
    });
}
async function doImportFile(file) {
    if (!file) return false;
    const version = ++importVersion, revision = processingRevision, original = inputArea.value;
    if (file.size > MAX_INPUT_SIZE) { showToast('文件超过 10 MiB，请拆分后导入'); return false; }
    try {
        const text = (await readTextFile(file)).replace(/^\uFEFF/, '');
        if (version !== importVersion || revision !== processingRevision || inputArea.value !== original) return false;
        if (text.includes('\0')) throw new Error('请选择 UTF-8 文本文件');
        if (!replaceEditorText(text, file.name || '')) return false;
        showToast('✓ 已导入文件'); return true;
    } catch (e) { showToast(e.message || '读取文件失败'); return false; }
}
document.getElementById('fileInput').addEventListener('change', event => {
    const file = event.target.files[0]; event.target.value = ''; doImportFile(file);
});
function getDownloadPayload() {
    let text = document.getElementById('formattedCode').textContent;
    if (!text || currentData === null) return null;
    const xml = currentType === 'xml';
    if (xml) text = text.replace(/^(<\?xml\b[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/i, '$1"UTF-8"');
    const basename = importedName ? importedName.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '_') : 'formatted';
    return { text, name: basename + (xml ? '.xml' : '.json'), mime: xml ? 'application/xml;charset=utf-8' : 'application/json;charset=utf-8' };
}
function doDownload() {
    const payload = getDownloadPayload();
    if (!payload) { showToast('请先输入有效内容'); return; }
    const url = URL.createObjectURL(new Blob([payload.text], { type: payload.mime }));
    const link = document.createElement('a'); link.href = url; link.download = payload.name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('✓ 已下载结果');
}
async function performLargeJsonOperation(raw, indent, sort = false) {
    rememberInput();
    const revision = ++processingRevision;
    cancelJsonTasks();
    document.getElementById('processingStatus').textContent = '后台处理中…';
    try {
        const result = await runJsonTask(raw, indent, sort, false);
        if (revision !== processingRevision || inputArea.value.trim() !== raw) return;
        if (replaceEditorText(result.text)) showToast(sort ? '✓ 已按 Key 字母排序' : indent ? '✓ JSON 格式化完成' : '✓ JSON 已压缩');
    } catch (error) {
        if (revision === processingRevision && inputArea.value.trim() === raw) { invalidateOutput(); showJsonError(raw, error); }
    } finally {
        // replaceEditorText may have started a new background parse.
        if (revision === processingRevision) document.getElementById('processingStatus').textContent = '';
    }
}
updateHistoryButtons();
