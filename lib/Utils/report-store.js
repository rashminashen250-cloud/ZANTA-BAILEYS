import { getBinaryNodeChild, isJidGroup, isJidBroadcast, isJidNewsletter, jidDecode } from '../WABinary/index.js';
import { extractMessageContent } from './messages.js';

const MESSAGE_TYPES = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker',
    contactMessage: 'contact',
    locationMessage: 'location'
};

const userOf = (jid) => jidDecode(jid)?.user;

/**
 * Keeps the most recent incoming messages (with their `reporting_token`) per sender,
 * so they can be used later with `sock.reportSpam(jid, { messages })`.
 * In-memory only: it is filled while the bot is running.
 */
export const createReportStore = ({ maxUsers = 1000, perUser = 5 } = {}) => {
    /** @type {Map<string, Array<object>>} user part of JID -> newest-first entries */
    const store = new Map();

    const record = (node, msg) => {
        try {
            if (!msg?.key || msg.key.fromMe) return;
            const from = node?.attrs?.from;
            if (!from || isJidGroup(from) || isJidBroadcast(from) || isJidNewsletter(from)) return;
            const reporting = getBinaryNodeChild(node, 'reporting');
            const tokenNode = reporting ? getBinaryNodeChild(reporting, 'reporting_token') : undefined;
            const raw = tokenNode?.content;
            if (!raw || !raw.length) return;

            const content = msg.message ? extractMessageContent(msg.message) : undefined;
            const contentKey = content ? Object.keys(content).find(k => MESSAGE_TYPES[k]) : undefined;
            const entry = {
                stanzaId: msg.key.id,
                fromJid: from,
                reportingTag: Buffer.from(raw),
                text: content?.conversation ?? content?.extendedTextMessage?.text ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? '',
                pushName: msg.pushName || '',
                timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
                messageType: contentKey ? MESSAGE_TYPES[contentKey] : 'text'
            };

            const users = new Set([userOf(from), userOf(msg.key.remoteJid), userOf(msg.key.remoteJidAlt)].filter(Boolean));
            for (const user of users) {
                const list = store.get(user) || [];
                list.unshift(entry);
                list.length = Math.min(list.length, perUser);
                store.delete(user); // re-insert so the Map keeps recency order
                store.set(user, list);
            }
            while (store.size > maxUsers) {
                store.delete(store.keys().next().value);
            }
        }
        catch {
            // never break message handling because of the report store
        }
    };

    /** Returns up to `limit` recent reportable messages for any of the given JIDs / numbers. */
    const get = (jids, limit = perUser) => {
        const seen = new Set();
        const out = [];
        for (const jid of [].concat(jids)) {
            if (!jid) continue;
            const user = String(jid).includes('@') ? userOf(jid) : String(jid);
            for (const entry of store.get(user) || []) {
                if (seen.has(entry.stanzaId)) continue;
                seen.add(entry.stanzaId);
                out.push(entry);
            }
        }
        return out.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    };

    return { record, get };
};
