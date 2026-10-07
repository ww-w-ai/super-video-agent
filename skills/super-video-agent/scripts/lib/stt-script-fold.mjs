// Script folding before the speech-to-text comparison (stt-compare.mjs).
// The check only asks "did the voice say the line", so a Traditional line that
// the model wrote in Simplified characters, or a katakana word it wrote in
// hiragana, is a correct reading. Both sides are folded the same way; the folded
// text is only used for the comparison (a diff report shows it).
//
// Coverage is a table of common characters, not a full converter: a character
// that is not listed stays as it is, so an unlisted pair still counts as a
// difference.

// Traditional character then Simplified character, pair after pair.
const ZH_PAIRS =
  "會会員员據据說说過过兩两億亿萬万現现個个們们來来對对這这為为學学開开關关時时間间門门問问題题與与還还點点線线機机電电腦脑視视頻频書书讀读寫写語语話话認认識识實实際际種种質质號号碼码買买賣卖錢钱價价費费貿贸業业務务經经濟济織织維维護护運运動动場场區区園园國国圖图團团畫画藝艺術术樂乐歡欢愛爱戀恋親亲兒儿婦妇孫孙媽妈爺爷劉刘張张陳陈楊杨黃黄鄭郑許许謝谢盧卢蘇苏賴赖葉叶嚴严龍龙鳳凤鳥鸟魚鱼雞鸡貓猫馬马駕驾驗验騎骑騰腾體体髮发發发鬥斗麼么黨党齊齐齡龄齒齿歲岁歷历曆历壓压厭厌廠厂廣广慶庆應应懷怀態态戰战戲戏攝摄擊击擔担數数斷断於于晝昼條条極极構构樣样檢检權权歐欧歸归殘残殺杀氣气漢汉沒没潔洁澤泽濃浓濕湿灣湾無无煩烦燈灯營营爾尔牆墙獨独獲获環环產产畢毕療疗盡尽監监碩硕礎础禮礼禍祸穩稳窮穷競竞節节築筑簡简糧粮紀纪約约級级紅红納纳純纯紙纸紗纱組组細细終终絕绝統统絲丝綠绿綱纲網网緊紧練练縣县總总繼继續续罷罢羅罗義义習习聖圣聞闻聯联職职聽听肅肃腳脚臺台舊旧艱艰莊庄華华蓋盖蔣蒋蘭兰處处蟲虫衛卫補补裝装裡里製制複复見见規规覺觉覽览觀观計计訂订訊讯討讨訓训託托記记訪访設设訴诉診诊註注評评詞词詢询該该詳详誇夸誌志誤误誰谁課课調调談谈請请論论諸诸諾诺謀谋證证譜谱議议變变讓让豐丰貝贝負负財财貢贡貧贫貨货販贩貪贪貫贯責责貴贵貼贴賀贺資资賓宾賞赏賢贤賤贱賬账賭赌購购贈赠贏赢趕赶趨趋跡迹踐践蹤踪軍军軟软軸轴較较載载輕轻輝辉輩辈輪轮輸输轉转轟轰辦办辭辞農农連连週周達达遞递遠远適适選选遺遗邊边邏逻鄉乡鄰邻醫医釋释針针釘钉鈴铃銀银銅铜銷销鋼钢錄录錯错鍵键鎖锁鏡镜長长閃闪閉闭閒闲閱阅隊队階阶隨随險险隱隐雙双雜杂雖虽雲云霧雾靜静響响頁页頂顶項项順顺須须預预頓顿頭头顏颜額额願愿顯显風风飛飞飯饭飲饮餅饼餘余館馆饑饥驚惊鬆松鬚须鬧闹魯鲁鮮鲜鳴鸣麗丽麵面啟启啓启喚唤嗎吗嘗尝單单壞坏夢梦奪夺奮奋屆届屬属嶺岭帶带幣币幫帮廳厅彎弯後后從从徵征復复憂忧憶忆擁拥擇择擴扩攜携敵敌斬斩暫暂曬晒棄弃棟栋槍枪檔档櫃柜欄栏殼壳毀毁氫氢沖冲況况準准溝沟滅灭滿满漲涨潛潜澀涩濱滨瀏浏熱热獎奖獸兽獻献瑪玛當当瘋疯盤盘眾众矚瞩確确礦矿稅税稱称積积穀谷筆笔範范篩筛籃篮粵粤緒绪緣缘編编緩缓縱纵縫缝繪绘繩绳纖纤翹翘聲声腫肿膽胆臉脸臨临艦舰艷艳茲兹蘋苹藍蓝藥药蝕蚀蠟蜡螢萤裏里褲裤襲袭觸触訝讶詩诗試试誠诚誘诱説说豬猪軌轨辯辩遊游鄧邓鋒锋鍊炼鑰钥鑑鉴闊阔陣阵陸陆陽阳難难靈灵韓韩韻韵頗颇領领顆颗飄飘駐驻騙骗髒脏鯨鲸鷹鹰鹽盐麥麦";

/** Traditional -> Simplified, one entry per listed character. */
export const ZH_HANT_TO_HANS = (() => {
  const chars = Array.from(ZH_PAIRS);
  const map = new Map();
  for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i], chars[i + 1]);
  return map;
})();

/** Folds listed Traditional characters to Simplified; everything else is unchanged. */
export function hantToHans(s) {
  let out = "";
  for (const ch of String(s ?? "")) out += ZH_HANT_TO_HANS.get(ch) ?? ch;
  return out;
}

// Words whose kanji spelling has one reading, so the kana spelling is the same word.
const JA_KANJI_WORDS = [
  ["大丈夫", "だいじょうぶ"],
  ["有難う", "ありがとう"],
  ["有り難う", "ありがとう"],
  ["御座います", "ございます"],
  ["宜しく", "よろしく"],
  ["下さい", "ください"],
  ["一緒", "いっしょ"],
  ["今日", "きょう"],
  ["明日", "あした"],
  ["昨日", "きのう"],
  ["今年", "ことし"],
  ["去年", "きょねん"],
  ["来年", "らいねん"],
  ["毎日", "まいにち"],
  ["毎年", "まいとし"],
  ["私", "わたし"],
  ["僕", "ぼく"],
  ["貴方", "あなた"],
];

/** Katakana to hiragana (the long-vowel mark stays). */
export function kataToHira(s) {
  return String(s ?? "").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Kana and the single-reading kanji words written one way. */
export function foldJapanese(s) {
  let t = String(s ?? "");
  for (const [kanji, kana] of JA_KANJI_WORDS) t = t.split(kanji).join(kana);
  return kataToHira(t);
}

/** Korean endings that speech-to-text and writers spell either way (both read the same). */
const KO_SAME_SOUND = [["예요", "에요"]];

/** Korean endings with one sound written one way (-예요 and -에요). */
export function foldKorean(s) {
  let t = String(s ?? "");
  for (const [from, to] of KO_SAME_SOUND) t = t.split(from).join(to);
  return t;
}

/**
 * Folds `s` the way `lang` needs: zh -> Simplified, ja -> hiragana and
 * single-reading kanji words, ko -> same-sound endings. Other languages are
 * returned unchanged.
 * @param {string} s
 * @param {string|null|undefined} primary primary language subtag ("zh", "ja", "ko", ...)
 */
export function foldScript(s, primary) {
  if (primary === "zh") return hantToHans(s);
  if (primary === "ja") return foldJapanese(s);
  if (primary === "ko") return foldKorean(s);
  return String(s ?? "");
}
