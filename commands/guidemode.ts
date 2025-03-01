import { Command } from './types'

export const guideModeCommand: Command = {
    name: 'guidemode',
    description: 'Enter guided interaction mode',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Guide mode is not implemented yet.");
    }
}