/**
 * AntiTag Command
 * Enable/disable anti-tag and set action (warn/delete/kick)
 */

const database = require('../../database');

module.exports = {
  name: 'antitag',
  aliases: ['antimention', 'at'],
  description: 'Configure anti-tag protection (tagall/hidetag)',
  usage: '.antitag <on/off/set/get>',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,
  
  async execute(sock, msg, args, extra) {
    try {
      if (!args[0]) {
        const settings = database.getGroupSettings(extra.from);
        const status = settings.antitag ? 'ON' : 'OFF';
        const action = settings.antitagAction || 'delete';
        return extra.reply(
          `📛 Anti-tag is *${status}* (action: *${action}*).\n` +
          'Usage:\n' +
          '  .antitag on\n' +
          '  .antitag off\n' +
          '  .antitag set warn | delete | kick\n' +
          '  .antitag get'
        );
      }
      
      const opt = args[0].toLowerCase();
      
      if (opt === 'on') {
        if (database.getGroupSettings(extra.from).antitag) {
          return extra.reply('*Antitag is already on*');
        }
        database.updateGroupSettings(extra.from, { antitag: true });
        return extra.reply(`*Antitag has been turned ON*\nAction: *${database.getGroupSettings(extra.from).antitagAction || 'delete'}* (badalne ke liye: .antitag set warn | delete | kick)`);
      }
      
      if (opt === 'off') {
        database.updateGroupSettings(extra.from, { antitag: false });
        return extra.reply('*Antitag has been turned OFF*');
      }
      
      if (opt === 'set') {
        if (args.length < 2) {
          return extra.reply('*Please specify an action: .antitag set warn | delete | kick*');
        }
        
        const setAction = args[1].toLowerCase();
        if (!['warn', 'delete', 'kick'].includes(setAction)) {
          return extra.reply('*Invalid action. Choose warn, delete or kick.*');
        }
        
        database.updateGroupSettings(extra.from, { 
          antitagAction: setAction,
          antitag: true // Auto-enable when setting action
        });
        const _d = { warn: 'Message delete + warning (3 warnings = remove)', delete: 'Message sirf delete (silent)', kick: 'Message delete + user remove' }[setAction];
        return extra.reply(`✅ *Antitag action set: ${setAction}*\n${_d}\n\n(Antitag ab *ON* hai)`);
      }
      
      if (opt === 'get') {
        const settings = database.getGroupSettings(extra.from);
        const status = settings.antitag ? 'ON' : 'OFF';
        const action = settings.antitagAction || 'delete';
        return extra.reply(`*Antitag Configuration:*\nStatus: ${status}\nAction: ${action}`);
      }
      
      return extra.reply('*Use .antitag for usage.*');
      
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
