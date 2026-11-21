import { getBinaryNodeChild, getBinaryNodeChildString, isHostedLidUser, isJidGroup, isLidUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { extractMessageContent } from './messages.js';
export const SPAM_FLOWS = {
    ACCOUNT_INFO_REPORT: 'account_info_report',
    ACCOUNT_INFO_BLOCK: 'account_info_block',
    GROUP_INFO_REPORT: 'group_info_report',
    CONTACT_INFO_REPORT: 'contact_info_report',
    ONE_TO_ONE_SPAM_BANNER_REPORT: '1_1_spam_banner_report',
    MESSAGE_MENU: 'message_menu',
    OVERFLOW_MENU_REPORT: 'overflow_menu_report'
};
export const REPORT_REASON_CODES = {
    spam: 1,
    harassment: 2,
    impersonation: 3,
    scam: 4,
    other: 5
};
const toBuffer = (data) => {
    if (!data)
        return null;
    if (Buffer.isBuffer(data))
        return data;
    if (data instanceof Uint8Array)
        return Buffer.from(data);
    if (typeof data === 'string')
        return Buffer.from(data, 'base64');
    return null;
};
export const resolveReportJid = async (jid, lidMapping) => {
    if (!jid)
        throw new Error('resolveReportJid: jid required');
    if (isJidGroup(jid) || isLidUser(jid) || isHostedLidUser(jid))
        return jid;
    const lid = lidMapping?.getLIDForPN ? await lidMapping.getLIDForPN(jid) : null;
    return lid ?? jid;
};
export const resolveReportContext = async (jid, lidMapping) => {
    if (!jid)
        throw new Error('resolveReportContext: jid required');
    if (isJidGroup(jid))
        return { reportJid: jid, spamFlow: SPAM_FLOWS.GROUP_INFO_REPORT, isGroup: true };
    return { reportJid: await resolveReportJid(jid, lidMapping), spamFlow: SPAM_FLOWS.ACCOUNT_INFO_REPORT, isGroup: false };
};
export const normalizeReportingTag = (tag) => {
    const buf = toBuffer(tag);
    return buf?.length ? buf : null;
};
export const extractMessageText = (msg) => {
    if (!msg?.message)
        return '';
    const c = extractMessageContent(msg.message);
    if (!c)
        return '';
    return c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? '';
};
export const buildSpamReportMessageNodes = (messages, logger) => {
    const ts = () => Math.floor(Date.now() / 1000);
    const nodes = (messages || []).slice(0, 5).reduce((acc, m) => {
        const reportingTag = normalizeReportingTag(m.reportingTag);
        if (!reportingTag) {
            logger?.warn?.({ stanzaId: m.stanzaId }, 'buildSpamReportMessageNodes: skipping - missing reportingTag');
            return acc;
        }
        const t = String(m.timestamp || ts());
        acc.push({
            tag: 'message',
            attrs: { t, id: m.stanzaId, reported_push_name: m.pushName || '', type: m.messageType || 'text', from: m.fromJid },
            content: [
                { tag: 'raw', attrs: { local_message_type: '0', v: '2' }, content: m.text != null ? String(m.text) : '' },
                {
                    tag: 'reporting',
                    attrs: {},
                    content: [{ tag: 'reporting_validation', attrs: {}, content: [{ tag: 'reporting_tag', attrs: { id: m.stanzaId, ts_s: t }, content: reportingTag }] }]
                }
            ]
        });
        return acc;
    }, []);
    if (!nodes.length) {
        throw new Error('reportSpam: no valid messages with reportingTag found');
    }
    return nodes;
};
export const buildSpamReportIq = (jid, messages, spamFlow = SPAM_FLOWS.ACCOUNT_INFO_REPORT, logger) => {
    if (!messages?.length) {
        throw new Error('reportSpam: at least one message with reporting_tag required');
    }
    return {
        tag: 'iq',
        attrs: { type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
        content: [{ tag: 'spam_list', attrs: { jid, spam_flow: spamFlow }, content: buildSpamReportMessageNodes(messages, logger) }]
    };
};
export const buildSimpleReportNode = (jid, messageKeys) => ({
    tag: 'report',
    attrs: { jid, type: 'spam' },
    content: (messageKeys || []).map(key => ({ tag: 'message', attrs: { id: key.id || key, ...(key.fromMe ? {} : { from: jid }) } }))
});
export const parseSpamReportResponse = (result) => {
    if (!result)
        return { success: false, error: 'empty response' };
    if (result.attrs?.type === 'error') {
        const errNode = getBinaryNodeChild(result, 'error');
        const code = errNode?.attrs?.code;
        const text = errNode?.content?.toString?.() || errNode?.attrs?.text;
        return { success: false, error: `spam IQ error${code ? ` ${code}` : ''}${text ? `: ${text}` : ''}` };
    }
    const reportNode = getBinaryNodeChild(result, 'report');
    const reportId = reportNode?.attrs?.id || getBinaryNodeChildString(reportNode, 'id');
    if (reportId)
        return { success: true, reportId: String(reportId) };
    if (result.attrs?.type === 'result')
        return { success: true };
    return { success: false, error: 'unexpected spam IQ response' };
};
