import {
    CUSTOM_COMMAND,
    CUSTOM_COMMAND_DESCRIPTION,
    DATABASE,
    ENV,
    ENV_KEY_MAPPER,
    PLUGINS_COMMAND,
    PLUGINS_COMMAND_DESCRIPTION,
    mergeEnvironment,
} from '../config/env';
import {
    loadChatLLM,
    loadImageGen,
} from '../agent/agents';
import type { WorkerContext } from '../config/context';
import type { RequestTemplate } from '../plugins/template';
import {
    executeRequest,
    formatInput,
} from '../plugins/template';
import type { HistoryItem, HistoryModifierResult } from '../agent/types';
import type { TelegramChatType, TelegramMessage } from '../types/telegram';
import { isTelegramChatTypeGroup } from '../types/telegram';
import {
    sendChatActionToTelegramWithContext,
    sendMessageToTelegramWithContext,
    sendPhotoToTelegramWithContext,
    setMyCommands,
} from './telegram';
import { chatWithLLM } from './agent';
import { getChatRoleWithContext } from './utils';

const commandAuthCheck = {
    default(chatType: TelegramChatType): string[] | null {
        if (isTelegramChatTypeGroup(chatType)) {
            return ['administrator', 'creator'];
        }
        return null;
    },
    shareModeGroup(chatType: TelegramChatType): string[] | null {
        if (isTelegramChatTypeGroup(chatType)) {
            // 每个人在群里有上下文的时候，不限制
            if (!ENV.GROUP_CHAT_BOT_SHARE_MODE) {
                return null;
            }
            return ['administrator', 'creator'];
        }
        return null;
    },
};

const commandSortList: string[] = [
    '/new',
    '/redo',
    '/img',
    '/setenv',
    '/delenv',
    '/version',
    '/system',
    '/help',
];

interface CommandHandler {
    scopes: string[];
    fn: (message: TelegramMessage, command: string, subcommand: string, context: WorkerContext) => Promise<Response>;
    needAuth?: (chatType: TelegramChatType) => string[] | null;
}

const commandHandlers: Record<string, CommandHandler> = {
    '/help': {
        scopes: ['all_private_chats', 'all_chat_administrators'],
        fn: commandGetHelp,
    },
    '/new': {
        scopes: ['all_private_chats', 'all_group_chats', 'all_chat_administrators'],
        fn: commandCreateNewChatContext,
    },
    '/start': {
        scopes: [],
        fn: commandCreateNewChatContext,
    },
    '/img': {
        scopes: ['all_private_chats', 'all_chat_administrators'],
        fn: commandGenerateImg,
    },
    '/version': {
        scopes: ['all_private_chats', 'all_chat_administrators'],
        fn: commandFetchUpdate,
    },
    '/setenv': {
        scopes: [],
        fn: commandUpdateUserConfig,
        needAuth: commandAuthCheck.shareModeGroup,
    },
    '/setenvs': {
        scopes: [],
        fn: commandUpdateUserConfigs,
        needAuth: commandAuthCheck.shareModeGroup,
    },
    '/delenv': {
        scopes: [],
        fn: commandDeleteUserConfig,
        needAuth: commandAuthCheck.shareModeGroup,
    },
    '/clearenv': {
        scopes: [],
        fn: commandClearUserConfig,
        needAuth: commandAuthCheck.shareModeGroup,
    },
    '/system': {
        scopes: ['all_private_chats', 'all_chat_administrators'],
        fn: commandSystem,
        needAuth: commandAuthCheck.default,
    },
    '/redo': {
        scopes: ['all_private_chats', 'all_group_chats', 'all_chat_administrators'],
        fn: commandRegenerate,
    },
};

async function commandGenerateImg(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    if (subcommand === '') {
        return sendMessageToTelegramWithContext(context)(ENV.I18N.command.help.img);
    }
    try {
        const agent = loadImageGen(context.USER_CONFIG);
        if (!agent) {
            return sendMessageToTelegramWithContext(context)('ERROR: Image generator not found');
        }
        setTimeout(() => sendChatActionToTelegramWithContext(context)('upload_photo').catch(console.error), 0);
        const img = await agent.request(subcommand, context.USER_CONFIG);
        const resp = await sendPhotoToTelegramWithContext(context)(img);
        if (!resp.ok) {
            return sendMessageToTelegramWithContext(context)(`ERROR: ${resp.statusText} ${await resp.text()}`);
        }
        return resp;
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandGetHelp(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    let helpMsg = `${ENV.I18N.command.help.summary}\n`;
    helpMsg += Object.keys(commandHandlers)
        .map(key => `${key}：${(ENV.I18N.command.help as any)[key.substring(1)]}`)
        .join('\n');
    helpMsg += Object.keys(CUSTOM_COMMAND)
        .filter(key => !!CUSTOM_COMMAND_DESCRIPTION[key])
        .map(key => `${key}：${CUSTOM_COMMAND_DESCRIPTION[key]}`)
        .join('\n');
    helpMsg += Object.keys(PLUGINS_COMMAND)
        .filter(key => !!PLUGINS_COMMAND_DESCRIPTION[key])
        .map(key => `${key}：${PLUGINS_COMMAND_DESCRIPTION[key]}`)
        .join('\n');
    return sendMessageToTelegramWithContext(context)(helpMsg);
}

async function commandCreateNewChatContext(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    try {
        await DATABASE.delete(context.SHARE_CONTEXT.chatHistoryKey);

        const isNewCommand = command.startsWith('/new');
        const text = ENV.I18N.command.new.new_chat_start + (isNewCommand ? '' : `(${context.CURRENT_CHAT_CONTEXT.chat_id})`);

        // 非群组消息，显示回复按钮
        if (ENV.SHOW_REPLY_BUTTON && !isTelegramChatTypeGroup(context.SHARE_CONTEXT.chatType)) {
            context.CURRENT_CHAT_CONTEXT.reply_markup = {
                keyboard: [[{ text: '/new' }, { text: '/redo' }]],
                selective: true,
                resize_keyboard: true,
                one_time_keyboard: false,
            };
        } else {
            context.CURRENT_CHAT_CONTEXT.reply_markup = {
                remove_keyboard: true,
                selective: true,
            };
        }

        return sendMessageToTelegramWithContext(context)(text);
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandUpdateUserConfig(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    const kv = subcommand.indexOf('=');
    if (kv === -1) {
        return sendMessageToTelegramWithContext(context)(ENV.I18N.command.help.setenv);
    }
    let key = subcommand.slice(0, kv);
    const value = subcommand.slice(kv + 1);
    key = ENV_KEY_MAPPER[key] || key;
    if (ENV.LOCK_USER_CONFIG_KEYS.includes(key)) {
        return sendMessageToTelegramWithContext(context)(`Key ${key} is locked`);
    }
    if (!Object.keys(context.USER_CONFIG).includes(key)) {
        return sendMessageToTelegramWithContext(context)(`Key ${key} not found`);
    }
    try {
        context.USER_CONFIG.DEFINE_KEYS.push(key);
        context.USER_CONFIG.DEFINE_KEYS = Array.from(new Set(context.USER_CONFIG.DEFINE_KEYS));
        mergeEnvironment(context.USER_CONFIG, {
            [key]: value,
        });
        console.log('Update user config: ', key, (context.USER_CONFIG as any)[key]);
        await DATABASE.put(
            context.SHARE_CONTEXT.configStoreKey,
            JSON.stringify(context.USER_CONFIG.trim(ENV.LOCK_USER_CONFIG_KEYS)),
        );
        return sendMessageToTelegramWithContext(context)('Update user config success');
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandUpdateUserConfigs(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    try {
        const values = JSON.parse(subcommand);
        const configKeys = Object.keys(context.USER_CONFIG);
        for (const ent of Object.entries(values)) {
            let [key, value] = ent;
            key = ENV_KEY_MAPPER[key] || key;
            if (ENV.LOCK_USER_CONFIG_KEYS.includes(key)) {
                return sendMessageToTelegramWithContext(context)(`Key ${key} is locked`);
            }
            if (!configKeys.includes(key)) {
                return sendMessageToTelegramWithContext(context)(`Key ${key} not found`);
            }
            context.USER_CONFIG.DEFINE_KEYS.push(key);
            mergeEnvironment(context.USER_CONFIG, {
                [key]: value,
            });
            console.log('Update user config: ', key, (context.USER_CONFIG as any)[key]);
        }
        context.USER_CONFIG.DEFINE_KEYS = Array.from(new Set(context.USER_CONFIG.DEFINE_KEYS));
        await DATABASE.put(
            context.SHARE_CONTEXT.configStoreKey,
            JSON.stringify(context.USER_CONFIG.trim(ENV.LOCK_USER_CONFIG_KEYS)),
        );
        return sendMessageToTelegramWithContext(context)('Update user config success');
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandDeleteUserConfig(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    if (ENV.LOCK_USER_CONFIG_KEYS.includes(subcommand)) {
        const msg = `Key ${subcommand} is locked`;
        return sendMessageToTelegramWithContext(context)(msg);
    }
    try {
        (context.USER_CONFIG as any)[subcommand] = null;
        context.USER_CONFIG.DEFINE_KEYS = context.USER_CONFIG.DEFINE_KEYS.filter(key => key !== subcommand);
        await DATABASE.put(
            context.SHARE_CONTEXT.configStoreKey,
            JSON.stringify(context.USER_CONFIG.trim(ENV.LOCK_USER_CONFIG_KEYS)),
        );
        return sendMessageToTelegramWithContext(context)('Delete user config success');
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandClearUserConfig(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    try {
        await DATABASE.put(
            context.SHARE_CONTEXT.configStoreKey,
            JSON.stringify({}),
        );
        return sendMessageToTelegramWithContext(context)('Clear user config success');
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandFetchUpdate(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    const current = {
        ts: ENV.BUILD_TIMESTAMP,
        sha: ENV.BUILD_VERSION,
    };

    try {
        const info = `https://raw.githubusercontent.com/TBXark/ChatGPT-Telegram-Workers/${ENV.UPDATE_BRANCH}/dist/buildinfo.json`;
        const online = await fetch(info).then(r => r.json()) as { ts: number; sha: string };
        const timeFormat = (ts: number): string => {
            return new Date(ts * 1000).toLocaleString('en-US', {});
        };
        if (current.ts < online.ts) {
            return sendMessageToTelegramWithContext(context)(`New version detected: ${online.sha}(${timeFormat(online.ts)})\nCurrent version: ${current.sha}(${timeFormat(current.ts)})`);
        } else {
            return sendMessageToTelegramWithContext(context)(`Current version: ${current.sha}(${timeFormat(current.ts)}) is up to date`);
        }
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function commandSystem(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    const chatAgent = loadChatLLM(context.USER_CONFIG);
    const imageAgent = loadImageGen(context.USER_CONFIG);
    const agent = {
        AI_PROVIDER: chatAgent?.name,
        [chatAgent?.modelKey || 'AI_PROVIDER_NOT_FOUND']: chatAgent?.model(context.USER_CONFIG),
        AI_IMAGE_PROVIDER: imageAgent?.name,
        [imageAgent?.modelKey || 'AI_IMAGE_PROVIDER_NOT_FOUND']: imageAgent?.model(context.USER_CONFIG),
    };
    let msg = `AGENT: ${JSON.stringify(agent, null, 2)}\n`;
    if (ENV.DEV_MODE) {
        const shareCtx = { ...context.SHARE_CONTEXT };
        shareCtx.currentBotToken = '******';
        context.USER_CONFIG.OPENAI_API_KEY = ['******'];
        context.USER_CONFIG.AZURE_API_KEY = '******';
        context.USER_CONFIG.AZURE_COMPLETIONS_API = '******';
        context.USER_CONFIG.AZURE_DALLE_API = '******';
        context.USER_CONFIG.CLOUDFLARE_ACCOUNT_ID = '******';
        context.USER_CONFIG.CLOUDFLARE_TOKEN = '******';
        context.USER_CONFIG.GOOGLE_API_KEY = '******';
        context.USER_CONFIG.MISTRAL_API_KEY = '******';
        context.USER_CONFIG.COHERE_API_KEY = '******';
        context.USER_CONFIG.ANTHROPIC_API_KEY = '******';
        const config = context.USER_CONFIG.trim(ENV.LOCK_USER_CONFIG_KEYS);
        msg = `<pre>\n${msg}`;
        msg += `USER_CONFIG: ${JSON.stringify(config, null, 2)}\n`;
        msg += `CHAT_CONTEXT: ${JSON.stringify(context.CURRENT_CHAT_CONTEXT, null, 2)}\n`;
        msg += `SHARE_CONTEXT: ${JSON.stringify(shareCtx, null, 2)}\n`;
        msg += '</pre>';
    }
    context.CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
    return sendMessageToTelegramWithContext(context)(msg);
}

async function commandRegenerate(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    const mf = (history: HistoryItem[], text: string | null): HistoryModifierResult => {
        let nextText = text;
        if (!(history && Array.isArray(history) && history.length > 0)) {
            throw new Error('History not found');
        }
        const historyCopy = structuredClone(history);
        while (true) {
            const data = historyCopy.pop();
            if (data === undefined || data === null) {
                break;
            } else if (data.role === 'user') {
                if (text === '' || text === undefined || text === null) {
                    nextText = data.content || null;
                }
                break;
            }
        }
        if (subcommand) {
            nextText = subcommand;
        }
        return { history: historyCopy, message: nextText };
    };
    return chatWithLLM({ message: null }, context, mf);
}

async function commandEcho(message: TelegramMessage, command: string, subcommand: string, context: WorkerContext): Promise<Response> {
    let msg = '<pre>';
    msg += JSON.stringify({ message }, null, 2);
    msg += '</pre>';
    context.CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
    return sendMessageToTelegramWithContext(context)(msg);
}

async function handleSystemCommand(message: TelegramMessage, command: string, raw: string, handler: CommandHandler, context: WorkerContext): Promise<Response> {
    try {
        // 如果存在权限条件
        if (handler.needAuth) {
            const roleList = handler.needAuth(context.SHARE_CONTEXT.chatType);
            if (roleList) {
                // 获取身份并判断
                const chatRole = await getChatRoleWithContext(context);
                if (chatRole === null) {
                    return sendMessageToTelegramWithContext(context)('ERROR: Get chat role failed');
                }
                if (!roleList.includes(chatRole)) {
                    return sendMessageToTelegramWithContext(context)(`ERROR: Permission denied, need ${roleList.join(' or ')}`);
                }
            }
        }
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
    const subcommand = raw.substring(command.length).trim();
    try {
        return await handler.fn(message, command, subcommand, context);
    } catch (e) {
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}`);
    }
}

async function handlePluginCommand(message: TelegramMessage, command: string, raw: string, template: RequestTemplate, context: WorkerContext): Promise<Response> {
    try {
        const subcommand = raw.substring(command.length).trim();
        const DATA = formatInput(subcommand, template.input?.type);
        const { type, content } = await executeRequest(template, {
            DATA,
            ENV: ENV.PLUGINS_ENV,
        });
        if (type === 'image') {
            return sendPhotoToTelegramWithContext(context)(content);
        }
        switch (type) {
            case 'html':
                context.CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
                break;
            case 'markdown':
                context.CURRENT_CHAT_CONTEXT.parse_mode = 'Markdown';
                break;
            case 'text':
            default:
                context.CURRENT_CHAT_CONTEXT.parse_mode = null;
                break;
        }
        return sendMessageToTelegramWithContext(context)(content);
    } catch (e) {
        const help = PLUGINS_COMMAND_DESCRIPTION[command];
        return sendMessageToTelegramWithContext(context)(`ERROR: ${(e as Error).message}\n${help}`);
    }
}

/**
 * 注入命令处理器
 */
function injectCommandHandlerIfNeed() {
    if (ENV.DEV_MODE) {
        commandHandlers['/echo'] = {
            scopes: ['all_private_chats', 'all_chat_administrators'],
            fn: commandEcho,
            needAuth: commandAuthCheck.default,
        };
    }
}

export async function handleCommandMessage(message: TelegramMessage, context: WorkerContext): Promise<Response | null> {
    injectCommandHandlerIfNeed();
    // 触发自定义命令 替换为对应的命令
    let text = (message.text || message.caption || '').trim();
    if (CUSTOM_COMMAND[text]) {
        text = CUSTOM_COMMAND[text];
    }
    for (const key in PLUGINS_COMMAND) {
        if (text === key || text.startsWith(`${key} `)) {
            let template = PLUGINS_COMMAND[key].trim();
            if (template.startsWith('http')) {
                template = await fetch(template).then(r => r.text());
            }
            return await handlePluginCommand(message, key, text, JSON.parse(template), context);
        }
    }
    for (const key in commandHandlers) {
        if (text === key || text.startsWith(`${key} `)) {
            const command = commandHandlers[key];
            return await handleSystemCommand(message, key, text, command, context);
        }
    }
    return null;
}

export async function bindCommandForTelegram(token: string): Promise<{ ok: boolean; result: Record<string, any> }> {
    const scopeCommandMap: Record<string, string[]> = {
        all_private_chats: [],
        all_group_chats: [],
        all_chat_administrators: [],
    };
    for (const key of commandSortList) {
        if (ENV.HIDE_COMMAND_BUTTONS.includes(key)) {
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(commandHandlers, key) && commandHandlers[key].scopes) {
            for (const scope of commandHandlers[key].scopes) {
                if (!scopeCommandMap[scope]) {
                    scopeCommandMap[scope] = [];
                }
                scopeCommandMap[scope].push(key);
            }
        }
    }

    const result: Record<string, any> = {};
    for (const scope in scopeCommandMap) {
        const body = {
            commands: scopeCommandMap[scope].map(command => ({
                command,
                description: (ENV.I18N.command.help as any)[command.substring(1)] || '',
            })),
            scope: {
                type: scope,
            },
        };
        result[scope] = await setMyCommands(body, token).then(res => res.json());
    }
    return {
        ok: true,
        result,
    };
}

export function commandsDocument(): { description: string; command: string }[] {
    return Object.keys(commandHandlers).map((key) => {
        return {
            command: key,
            description: (ENV.I18N.command.help as any)[key.substring(1)],
        };
    });
}
