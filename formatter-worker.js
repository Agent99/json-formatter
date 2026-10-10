'use strict';
importScripts('json-core.js');
self.onmessage = ({ data: request }) => {
    try {
        const parsed = unwrapStructuredJsonString(request.raw);
        const value = request.sort ? sortObjectKeys(parsed.value) : parsed.value;
        const text = stringifyLosslessJson(value, null, request.indent);
        const numbers = [];
        if (request.returnData) {
            const stack = [{ value, path: [] }];
            while (stack.length) {
                const item = stack.pop();
                if (item.value instanceof JsonNumber) numbers.push(item.path);
                else if (item.value && typeof item.value === 'object') {
                    for (const key of Object.keys(item.value)) stack.push({ value: item.value[key], path: item.path.concat(key) });
                }
            }
        }
        self.postMessage({ id: request.id, text, value: request.returnData ? value : undefined, numbers });
    } catch (error) {
        self.postMessage({ id: request.id, error: error.message });
    }
};
