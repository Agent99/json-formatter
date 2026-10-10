// Shared by the page and its worker. Numbers retain their JSON spelling;
// JavaScript Number is never used to decode a numeric JSON token.
class JsonNumber {
    constructor(source) { this.source = source; Object.freeze(this); }
}

function parseLosslessJson(text) {
    let pos = 0;
    const fail = message => { throw new SyntaxError(`${message} at position ${pos}`); };
    const whitespace = () => { while (pos < text.length && /[\t\n\r ]/.test(text[pos])) pos++; };
    function string() {
        const start = pos++;
        while (pos < text.length) {
            const ch = text[pos++];
            if (ch === '\\') pos++;
            else if (ch === '"') return JSON.parse(text.slice(start, pos));
        }
        fail('字符串未闭合');
    }
    function value(depth) {
        if (depth > 512) fail('嵌套超过 512 层');
        whitespace();
        const ch = text[pos];
        if (ch === '"') return string();
        if (ch === '{' || ch === '[') {
            const array = ch === '[';
            const result = array ? [] : Object.create(null);
            const end = array ? ']' : '}';
            pos++; whitespace();
            if (text[pos] === end) { pos++; return result; }
            while (pos < text.length) {
                whitespace();
                let key;
                if (!array) {
                    if (text[pos] !== '"') fail('对象字段需要双引号');
                    key = string(); whitespace();
                    if (text[pos++] !== ':') fail('缺少冒号');
                }
                const child = value(depth + 1);
                if (array) result.push(child);
                else result[key] = child;
                whitespace();
                if (text[pos] === end) { pos++; return result; }
                if (text[pos++] !== ',') fail('缺少逗号或闭合括号');
            }
            fail('括号未闭合');
        }
        for (const [literal, decoded] of [['true', true], ['false', false], ['null', null]]) {
            if (text.startsWith(literal, pos)) { pos += literal.length; return decoded; }
        }
        const number = text.slice(pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (number) { pos += number[0].length; return new JsonNumber(number[0]); }
        fail('无效的 JSON 值');
    }
    const result = value(0);
    whitespace();
    if (pos !== text.length) fail('值后存在多余内容');
    return result;
}

function stringifyLosslessJson(value, unused = null, indent = 0) {
    const gap = typeof indent === 'number' ? ' '.repeat(Math.max(0, Math.min(10, indent))) : String(indent).slice(0, 10);
    function write(item, depth) {
        if (item instanceof JsonNumber) return item.source;
        if (item === null || typeof item !== 'object') return JSON.stringify(item);
        if (depth > 512) throw new Error('嵌套超过 512 层');
        const array = Array.isArray(item);
        const entries = array ? item.map(child => write(child, depth + 1)) :
            Object.keys(item).map(key => JSON.stringify(key) + (gap ? ': ' : ':') + write(item[key], depth + 1));
        const open = array ? '[' : '{', close = array ? ']' : '}';
        if (!entries.length) return open + close;
        return gap ? open + '\n' + gap.repeat(depth + 1) + entries.join(',\n' + gap.repeat(depth + 1)) + '\n' + gap.repeat(depth) + close : open + entries.join(',') + close;
    }
    return write(value, 0);
}

function sortObjectKeys(obj) {
    if (obj instanceof JsonNumber) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    if (obj !== null && typeof obj === 'object') {
        return Object.keys(obj).sort((a, b) => a.localeCompare(b))
            .reduce((acc, key) => { acc[key] = sortObjectKeys(obj[key]); return acc; }, Object.create(null));
    }
    return obj;
}

function unwrapStructuredJsonString(raw) {
    let candidate = raw.trim(), wasUnwrapped = false;
    for (let depth = 0; depth < 4; depth++) {
        const value = parseLosslessJson(candidate);
        if (depth < 3 && typeof value === 'string' && /^[\[{]/.test(value.trim())) {
            candidate = value.trim(); wasUnwrapped = true;
        } else return { value, wasUnwrapped };
    }
}

function formatStructuredJson(raw, indent = 2) {
    const parsed = unwrapStructuredJsonString(raw);
    return { ...parsed, text: stringifyLosslessJson(parsed.value, null, indent) };
}
