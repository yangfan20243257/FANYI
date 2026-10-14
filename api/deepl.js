'use strict';

// 每次使用请求者自己的密钥；不写入代码、日志、缓存或服务器存储。
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET') {
        return res.status(200).json({ ready: true, message: 'DeepL API Free 转发接口已部署。' });
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ message: '只支持 POST 翻译请求。' });
    }
    const origin = req.headers.origin;
    if (origin) {
        try {
            if (new URL(origin).host !== req.headers.host) {
                return res.status(403).json({ message: '请通过本站页面调用此接口。' });
            }
        } catch (_) {
            return res.status(403).json({ message: '无效的请求来源。' });
        }
    }
    const auth = req.headers.authorization;
    const match = typeof auth === 'string' && auth.match(/^DeepL-Auth-Key ([^\s]{1,256}:fx)$/);
    if (!match) {
        return res.status(401).json({ message: '请填写以 :fx 结尾的官方 DeepL API Free 密钥。' });
    }
    let body = req.body;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
        try { body = JSON.parse(body.toString()); }
        catch (_) { return res.status(400).json({ message: '请求必须是有效的 JSON。' }); }
    }
    if (!body || !Array.isArray(body.text) || body.text.length < 1 || body.text.length > 50 ||
        body.text.some(text => typeof text !== 'string' || !text.trim()) ||
        typeof body.target_lang !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(body.target_lang)) {
        return res.status(400).json({ message: '请提供有效的翻译文本和目标语言。' });
    }
    const payload = {
        text: body.text,
        target_lang: body.target_lang.toUpperCase(),
        preserve_formatting: true
    };
    if (body.source_lang !== undefined) {
        if (typeof body.source_lang !== 'string' || !/^[A-Za-z]{2,3}$/.test(body.source_lang)) {
            return res.status(400).json({ message: '无效的源语言代码。' });
        }
        payload.source_lang = body.source_lang.toUpperCase();
    }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') >= 128 * 1024) {
        return res.status(413).json({ message: '单次翻译文本过大，请减小分块大小。' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
        const response = await fetch('https://api-free.deepl.com/v2/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${match[1]}` },
            body: serialized,
            signal: controller.signal,
            redirect: 'error'
        });
        if (!response.ok) {
            const messages = {
                400: 'DeepL 拒绝了请求，请检查语言和文本设置。',
                403: 'DeepL 密钥认证失败，请检查密钥是否完整、有效，且属于 API Free。',
                413: 'DeepL 请求过大，请减小分块大小。',
                429: 'DeepL 请求过于频繁，请降低并发数量后重试。',
                456: 'DeepL 翻译额度已用完，请到官方账户查看用量。'
            };
            return res.status(response.status).json({ message: messages[response.status] || `DeepL 暂时不可用（${response.status}），请稍后重试。` });
        }
        const data = await response.json();
        if (!Array.isArray(data.translations) || data.translations.length !== payload.text.length ||
            data.translations.some(item => !item || typeof item.text !== 'string')) {
            return res.status(502).json({ message: 'DeepL 返回的翻译结果格式异常。' });
        }
        return res.status(200).json(data);
    } catch (error) {
        const timeout = controller.signal.aborted;
        return res.status(timeout ? 504 : 502).json({ message: timeout ? 'DeepL 请求超时，请减小分块或稍后重试。' : '服务器暂时无法连接 DeepL，请稍后重试。' });
    } finally {
        clearTimeout(timer);
    }
};
