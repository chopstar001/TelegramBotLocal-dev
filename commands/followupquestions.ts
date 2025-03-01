import { Command } from './types'

export const followUpQuestionsCommand: Command = {
    name: 'followupquestions',
    description: 'Get follow-up questions',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Follow-up questions functionality is not implemented yet.");
    }
}