'use strict';
/**
 * utils/emojiRoast.js — funny roast replies when someone sends ONLY one emoji in a group.
 *   • per-group switch:  .emojiroast on | off   (default ON, so old groups behave as before)
 *   • many emojis, several replies each (a random one is picked)
 *   • .emojiroast add 🍕 reply text   → group admins can add their own roast  ({n} = the person's @tag)
 * Light-hearted fun only — no abuse, no personal attacks.
 */
const database = require('../database');

const R = {
  '🥰': ['{n} Emoji bhej ke pyar jata rahe ho, par akal se bhi kabhi kaam le liya karo. 🙃', '{n} Itna pyar? Pehle apna wifi ka bill to bharo. 🥰😂', '{n} Dil dil kar rahe ho, aur dimaag chhutti pe hai. 🏖️'],
  '😍': ['{n} Itna kya ghoor rahe ho screen ko, group mein aur bhi log hain. 😑', '{n} Aankhon mein dil? Chasme ka number check karwa lo. 🤓', '{n} Pyar mein ho ya sirf network slow hai? 😍'],
  '😂': ['{n} Apni hi baat pe khud hi hass rahe ho, koi aur to hasa nahi. 😐', '{n} Hasna band karo, pados wale samjhenge pagal ho gaya. 😂', '{n} Joke tha kya? Hasi mujhe bhi dilao. 🤨'],
  '🤣': ['{n} Itna zor se hasne se pehle content dekh lo, hasi ka koi maza nahi. 🙄', '{n} Zameen pe lot-pot ho gaye? Kapde jhad lena. 🤣', '{n} Hass hass ke pet dard hoga, phir mujhe mat bolna. 🤭'],
  '😅': ['{n} Ye nervous wali hansi bata rahi hai ki kuch gadbad ki hai. 😅', '{n} Paseena sirf emoji mein nahi, tumhari shakal pe bhi dikh raha hai. 💦'],
  '😁': ['{n} Itne daant dikha rahe ho, dentist ka ad chal raha hai kya? 😁', '{n} Daant dikhane se achha hai dimaag dikhao. 🦷'],
  '😊': ['{n} Sharmane ki acting band, sab pata hai tumhe. 😊', '{n} Itni shareef smile? Pakka kuch chhupa rahe ho. 🧐'],
  '🙂': ['{n} Ye smile fake lag rahi hai, bilkul tumhari attendance jaisi. 🙂', '{n} Slight smile? Andar se to ro rahe ho. 🙃'],
  '🙃': ['{n} Ulta smile, ulta dimaag, sab ulta hi chal raha hai. 🙃', '{n} Zindagi seedhi nahi chalti to smile ulti kar li? 🙃'],
  '😘': ['{n} Kiss kisko bhej rahe ho? Group mein sab shaadi-shuda hain. 😳', '{n} Pehle kisi ko bata do, phir bhej dena. 😘😂'],
  '❤️': ['{n} Dil bhej rahe ho, par pehle apni chat history check kar lo. 😬', '{n} Dil dena asaan hai, nibhana mushkil, aur tumhare bas ka nahi. ❤️😏', '{n} Itne dil bhejte ho, ek dil khud ke liye bhi rakh lo. 💔'],
  '❤️‍🔥': ['{n} Aag lagi hui hai kya? Fire emoji se zyada garmi to tumhari baaton mein nahi. 😒', '{n} Jalte ho kya? Fire brigade bulaoon? 🚒'],
  '💔': ['{n} Dil toota? Pehle jodna to seekh lo. 💔😂', '{n} Break-up hua ya recharge khatam? 📵'],
  '💕': ['{n} Do dil dikha ke kya batana chahte ho, single ho tum. 💕😂', '{n} Itna pyar bikhera, Valentine ab bhi door hai. 🌹'],
  '🔥': ['{n} Fire bola, par yahan sirf tumhara data burn ho raha hai. 🔥😂', '{n} Aag laga ke bhaag jaoge, hamesha ki tarah. 🏃🔥'],
  '⚡': ['{n} Speed dikha rahe ho, jawab dene mein wahi speed kahan gayab ho jaati hai. ⚡', '{n} Bijli ka bill itna aaya hai ya tumhara dimaag chal raha hai? ⚡'],
  '😈': ['{n} Shaitan mode dikha rahe ho, asal mein sabse dara hua tum hi ho. 😏', '{n} Dar ke aage jeet hai, par tumhare aage sirf Wi-Fi. 😈'],
  '👿': ['{n} Gussa dikha rahe ho, par mummy ke saamne to bheegi billi ho. 😼'],
  '👑': ['{n} King ban rahe ho emoji se, taaj ke bina bhikari lag rahe ho. 👑', '{n} Raja saab, pehle apni chai to khud banana seekh lo. ☕👑'],
  '💀': ['{n} Marne wali baat kaunsi thi, tumhari soch hi pehle se marri hui hai. 💀', '{n} Skull bheja, bheja nahi laga. 💀'],
  '☠️': ['{n} Itna dar-dara ke kya milega, sabko pata hai tum chuhe se bhi darte ho. ☠️'],
  '🤔': ['{n} Itni soch rahe ho, aur nikal kya raha hai — kuch nahi. 🧠', '{n} Soch ke result aaye to bata dena, hum wait kar rahe hain. ⏳'],
  '😎': ['{n} Swag dikha rahe ho, par confidence sirf emoji mein hi hai. 😎', '{n} Dhoop nahi hai, ye chasma kis ke liye? 🕶️'],
  '🥶': ['{n} Thand lag rahi hai kya, ya tumhari baaton mein hamesha se garmi nahi thi. ❄️', '{n} Kambal le lo, aur dimaag bhi garam kar lo. 🧣'],
  '🥵': ['{n} Garmi lag rahi hai? AC chalao, dimaag to wese bhi ubal raha hai. 🥵'],
  '😭': ['{n} Ro mat, itni si baat pe? Group chhod ke jaana ho to bata dena. 😑', '{n} Aansu bachao, onion ke dam aur badhne wale hain. 🧅'],
  '😢': ['{n} Ek aansu aur bhej do, hum ginti kar rahe hain. 😢'],
  '🥺': ['{n} Yeh cute face lagane se kaam nahi banega, seedhi baat karo. 🙄', '{n} Aise dekhoge to billi bhi paisa de degi, hum se umeed mat rakho. 🐱'],
  '😡': ['{n} Gussa aaya? Achha hai, kam se kam kuch to feel kar rahe ho. 😤', '{n} Gussa thook do, nahi to BP badhega, hospital ka bill tum doge. 🏥'],
  '😠': ['{n} Itna gussa mat karo, chehra pehle hi kuch khaas nahi hai. 😠😂'],
  '🤬': ['{n} Gaali dene se pehle apni galti maan lo, faayda hoga. 🙃', '{n} Symbols mein gaali? Itni tameez seekhi kahan se? 🤐'],
  '🙌': ['{n} Taali bajane se pehle kuch karke to dikhao. 👏', '{n} Haath upar karke kya, lottery lagi hai? 🎰'],
  '👏': ['{n} Taali toh bohot bajate ho, kaam ka naam nahi sunte. 👏', '{n} Bas taliyan, kaam ki baat pe gayab. 👏😂'],
  '🙏': ['{n} Haath jod ke kya maang rahe ho? Padhai pe dhyaan do, bhagwan busy hain. 🙏', '{n} Itni dua mat maango, exam mein bhi pehle padh lena. 📚'],
  '👍': ['{n} Bas thumbs up? Poora jawab dene mein ungli dukhti hai kya? 👍', '{n} Ek hi to ungli utha payi, aur kuch ke liye himmat nahi? 👍'],
  '👎': ['{n} Thumbs down dene se pehle khud kuch kar ke dikhao. 👎'],
  '👀': ['{n} Kya ghoor rahe ho? Chhup-chhup ke sab dekhna band karo. 👀', '{n} Dekhne ke paise lagte hain, ek rupaya do. 👀💰'],
  '🤝': ['{n} Haath milaya, par cheez wapas nahi karte ho. 🤝😏'],
  '💪': ['{n} Muscle emoji mein hi hain, asli mein sabzi bhi nahi uthti. 💪😂', '{n} Gym ka fees bhar ke so jate ho, hum jante hain. 🏋️'],
  '✨': ['{n} Chamak dikha rahe ho, par asliyat sabko pata hai. ✨', '{n} Glitter lagane se personality nahi chamakti. ✨'],
  '💎': ['{n} Diamond bol rahe ho khud ko, koyla bhi tumse zyada chamakta hai. 💎', '{n} Hira ho to gharwale kab ke bech chuke hote. 💎😂'],
  '🚀': ['{n} Rocket bane phirte ho, zameen pe hi theek se chal nahi paate. 🚀', '{n} Chand tak jaoge ya sirf chat tak? 🌙'],
  '😴': ['{n} So gaye kya dimaag se, jaagte hue bhi so rahe lagte ho. 😴', '{n} Neend aa rahi hai to jao so jao, group tumhare bina bhi chal jayega. 🛌'],
  '🥱': ['{n} Jamhai le rahe ho? Tumhari baatein sunke hum bhi so gaye. 🥱'],
  '🤯': ['{n} Dimaag phatne ki baat kahan thi, khaali dimaag mein kya phatega. 🤯', '{n} Blast hua? Safai tum khud karna. 🧹'],
  '😏': ['{n} Yeh muskurahat chupa nahi payegi, sabko pata hai asliyat. 😏', '{n} Smirk karke kya jataoge? Sab jaante hain. 😏'],
  '😒': ['{n} Muh kyun bana rakha hai? Chehra pehle hi mashhoor hai. 😒'],
  '🙄': ['{n} Aankhein ghumane se dimaag nahi ghoomta. 🙄', '{n} Upar kya dhoondh rahe ho, chhat? 🏠'],
  '😐': ['{n} Poker face? Hum bhi dekh lete hain kitni der tak. 😐'],
  '😑': ['{n} Expression to do kuch, ya battery khatam ho gayi? 🔋'],
  '😳': ['{n} Itna kya ho gaya? Kuch galat kar ke pakde gaye lagte ho. 😳'],
  '😱': ['{n} Chillao mat, sirf message tha, bhoot nahi. 😱😂', '{n} Dar gaye? Dil mazboot rakhna seekho. 💓'],
  '🤡': ['{n} Aaj kal sab apne aap ko pehchan lete hain, achhi baat hai. 🤡', '{n} Circus ka ticket nahi kata, tum khud hi aa gaye. 🎪'],
  '🤮': ['{n} Ulti aa rahi hai? Doctor ko dikhao, chat se ilaaj nahi hota. 🤮'],
  '🤢': ['{n} Itna bura laga? Phir bhi yahin ho, hum jaante hain. 🤢'],
  '🤐': ['{n} Chup kyun ho gaye? Pehle bahut bol rahe the. 🤐'],
  '🤫': ['{n} Raaz hai to bataa do, sabko pata chal hi jata hai. 🤫'],
  '🤭': ['{n} Muh pe haath rakh ke hans rahe ho, kisko bewakoof bana rahe ho? 🤭'],
  '😬': ['{n} Daant bheench ke kya dikhana chahte ho? 😬'],
  '😇': ['{n} Farishta bane ho? Pankh to dikhao. 😇', '{n} Itne masoom? Seedha jannat ka ticket lo. ☁️'],
  '🥳': ['{n} Party kis baat ki? Hum to bulaye hi nahi gaye. 🥳', '{n} Birthday hai ya sirf bore ho rahe ho? 🎂'],
  '😋': ['{n} Zubaan andar karo, biryani nahi aa rahi. 😋'],
  '😜': ['{n} Aankh maar ke zubaan nikali, dimaag kahan chhoda? 😜'],
  '🤑': ['{n} Paise ki baat sunte hi chamak gaye, udhaar wapas karo pehle. 🤑'],
  '🍕': ['{n} Pizza bheja? Share bhi karte to achha tha. 🍕'],
  '🍔': ['{n} Burger dekh ke bhookh lagi? Pehle kaam karo. 🍔'],
  '🍌': ['{n} Kela bheja? Chhilka bhi tumhare dimaag se zyada kaam ka hai. 🍌'],
  '🍆': ['{n} Ye emoji yahan nahi chalega, seedhe seedhe baat karo. 🙅'],
  '🐒': ['{n} Aaina dekhne ki zaroorat nahi, bandar emoji se pehchaan gaye. 🐒'],
  '🐍': ['{n} Saanp ban ke dasne ke irade hain? Pehle dant to ugao. 🐍'],
  '🐶': ['{n} Kutte ka emoji bheja, khud ko pehchan liya kya? 🐶😂'],
  '🐱': ['{n} Meow? Doodh peene wale bacche ho kya? 🐱'],
  '🦁': ['{n} Sher bante ho, par chuhe ki awaaz aati hai. 🐭'],
  '🐺': ['{n} Bhediya ban rahe ho, andar se bheegi billi. 🐺'],
  '🦅': ['{n} Udne ki baat mat karo, seedhi par chadhne mein hanfte ho. 🦅'],
  '⚔️': ['{n} Talwar uthayi? Pehle pen uthao, padhai karo. ⚔️'],
  '🏆': ['{n} Trophy chahiye? Pehle ek kaam to poora karo. 🏆'],
  '🎉': ['{n} Kis baat ki party? Group ko bhi bata do. 🎉'],
  '🎂': ['{n} Cake ki baat? Pehle kaat ke bhejo. 🎂'],
  '😤': ['{n} Naak se dhuan nikal raha hai, thoda thanda pani piyo. 😤'],
  '🥲': ['{n} Muskura ke ro rahe ho, Oscar tumhara intezar kar raha hai. 🥲'],
  '🫡': ['{n} Salute karne se kaam nahi hota, jao ghar ka kaam karo. 🫡'],
  '🫠': ['{n} Pighal gaye? Pankha chalao. 🫠'],
  '😶': ['{n} Muh kahan gaya? Bol ke dikhao. 😶'],
  '🤨': ['{n} Ek bhauh uthane se sach nahi badal jata. 🤨'],
  '🧐': ['{n} Jasoos ban rahe ho, ghar ki chaabi to dhoondh lo pehle. 🧐'],
  '😪': ['{n} So jao yaar, chat tumhare bina bhi chal jayegi. 😪'],
  '😩': ['{n} Itna dramatic mat bano, drama company join kar lo. 🎭'],
  '😞': ['{n} Udaas? Chai pi lo, sab theek ho jayega. ☕'],
};

// variation selector + skin tone are ignored, so the plain / light / dark versions of an emoji all hit the same roast
const norm = (e) => String(e || '').trim().replace(/[️\u{1F3FB}-\u{1F3FF}]/gu, '');
const isEmojiG = (g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);
/** "🤦🏻‍♀️Itni akal…" or "🍕 text" -> { emoji, text }  (space after the emoji is optional) */
function splitLead(raw) {
  const str = String(raw || '').trim();
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)].map(x => x.segment) : Array.from(str);
  let i = 0; while (i < seg.length && isEmojiG(seg[i]) && i < 4) i++;
  return { emoji: seg.slice(0, i).join(''), text: seg.slice(i).join('').trim() };
}
const MAP = new Map(Object.entries(R).map(([k, v]) => [norm(k), v]));

function custom(groupId) { try { return database.getGroupSettings(groupId).emojiRoastCustom || {}; } catch (_) { return {}; } }
function isOn(groupId) {
  try {
    // is bot ka apna switch (agar .emojifight / .emojiroast se set kiya ho) pehle, warna group wala
    let id = 'default'; try { id = require('./botScope').id(); } catch (_) {}
    const mine = database.getBotSetting(id, `emojiRoast_${groupId}`, null);
    if (mine !== null) return mine !== false;
    return database.getGroupSettings(groupId).emojiRoast !== false;
  } catch (_) { return true; }
}

/** text of the roast for this exact message (only a single emoji / emoji sequence), or null */
function replyFor(groupId, body, senderNum) {
  if (!isOn(groupId)) return null;
  const k = norm(body);
  if (!k || k.length > 16) return null;
  const mine = custom(groupId)[k];
  const pool = (mine && mine.length ? mine : null) || MAP.get(k);
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)].replace(/\{n\}/g, '@' + senderNum);
}

module.exports = { replyFor, isOn, norm, splitLead, count: () => MAP.size, custom };
