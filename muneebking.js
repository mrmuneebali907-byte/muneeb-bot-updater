module.exports = {
    name: 'muneebking',
    aliases: ['muneeb', 'king'],
    category: 'owner',
    description: 'Test command for auto updater checking',
    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        
        await sock.sendMessage(chatId, { 
            text: '🔥 *MR MUNEEB ALI KA AUTO-UPDATE SUCCESSFUL HAI!* 🔥\n\nSystem successfully connected aur naya command automatic inject ho gaya hai. Boss full power mein hain! 😎' 
        }, { quoted: msg });
    }
};
