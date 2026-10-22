/** =====================================================================
 *  Re:Point 振り返りシステム
 *  ===================================================================== */

/** 回答シート名 */
var SHEET_ANSWERS = 'フォームの回答 1';

/**
 * 列定義（0始まり：getValues() の配列インデックス）
 * シートに書き込むときは colNo_() で1始まりの列番号に変換する
 */
var COL = {
  TIMESTAMP:       0,  // A タイムスタンプ
  EMAIL:           1,  // B メールアドレス
  CLASS_NO:        2,  // C クラス番号（1,2,3,4,桑の木）
  NAME_1:          3,  // D 1組の氏名
  NAME_2:          4,  // E 2組の氏名
  NAME_3:          5,  // F 3組の氏名
  NAME_4:          6,  // G 4組の氏名
  NAME_KUWA:       7,  // H 桑の木の氏名
  LEARNED:         8,  // I 学習内容
  UNDERSTOOD:      9,  // J 分かったこと
  DIFFICULT:      10,  // K わからなかったこと・難しかったこと
  SELF_EVAL:      11,  // L 自己評価（A,B,C）
  AI_COACH:       12,  // M AIコーチ回答
  TEACHER_COMMENT:13,  // N 先生コメント（手入力）
  TEACHER_DRAFT:  14,  // O 先生コメント素案（AI生成）
  GEN_STATUS:     15,  // P 生成状態（待機 / 生成済 / エラー）　※フェーズ2で追加
  CONTEXT_USED:   16,  // Q 使った文脈（確定 / 推定 / 授業設定のみ / 手がかりなし）
  CHECK_FLAG:     17   // R 確認の目印（要確認 / 質問あり / 再試行の回数 / エラー内容）
};

/** 生成状態（P列の値） */
var GEN_STATUS = { PENDING: '待機', DONE: '生成済', ERROR: 'エラー' };

/** クラス一覧（正規化後の値） */
var CLASS_LIST = ['1', '2', '3', '4', '桑の木'];

/** クラス → 氏名列 */
var NAME_COL_BY_CLASS = {
  '1': COL.NAME_1,
  '2': COL.NAME_2,
  '3': COL.NAME_3,
  '4': COL.NAME_4,
  '桑の木': COL.NAME_KUWA
};

/* =====================================================================
 *  共通ヘルパー
 * ===================================================================== */

/** 0始まりインデックス → 1始まりの列番号 */
function colNo_(idx) {
  return idx + 1;
}

/** ログイン中ユーザーのメールアドレス（小文字・空白除去） */
function getActiveEmail_() {
  var email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('ログイン情報が取得できません。');
  return email.trim().toLowerCase();
}

/**
 * 教師（管理者）のメールアドレスをスクリプトプロパティから取得して判定
 */
function isTeacherUser_() {
  var email = Session.getActiveUser().getEmail();
  if (!email) return false;

  var teacherEmailsProp = PropertiesService.getScriptProperties().getProperty('TEACHER_EMAILS');
  if (!teacherEmailsProp) return false;

  var teacherEmails = teacherEmailsProp.split(',').map(function(e) {
    return e.trim().toLowerCase();
  });

  return teacherEmails.indexOf(email.trim().toLowerCase()) !== -1;
}

function getSpreadsheet_() {
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('SPREADSHEET_IDが設定されていません。');
  return SpreadsheetApp.openById(ssId);
}

/** 回答シートの全データ（見出し行を含む） */
function getAnswerData_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_ANSWERS);
  if (!sheet) throw new Error('シート「' + SHEET_ANSWERS + '」が見つかりません。');
  return sheet.getDataRange().getValues();
}

/** セルの値を 'yyyy/MM/dd' の日付キーに変換（変換できなければ ''） */
function toDateKey_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  }
  if (v === null || v === undefined || v === '') return '';
  return v.toString().substring(0, 10).replace(/-/g, '/');
}

/** 'yyyy/MM/dd' 形式かどうか */
function isValidDateKey_(s) {
  return typeof s === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(s);
}

/**
 * クラス番号を正規化（"1" / 1 / "１" / "1組" → "1"、"桑の木" はそのまま）
 */
function normalizeClass_(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .trim()
    .replace(/[０-９]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/組$/, '');
}

/** 行データから氏名を取得（クラスに対応する列を優先） */
function getNameByClass_(row) {
  var col = NAME_COL_BY_CLASS[normalizeClass_(row[COL.CLASS_NO])];
  if (col !== undefined && row[col] && row[col].toString().trim()) {
    return row[col].toString().trim();
  }
  // クラス列と氏名列が食い違っている場合の保険：氏名列のどれかに値があれば使う
  for (var c = COL.NAME_1; c <= COL.NAME_KUWA; c++) {
    if (row[c] && row[c].toString().trim()) return row[c].toString().trim();
  }
  return '';
}

/** AIに渡す生徒の振り返りテキストを組み立てる（氏名は含めない） */
function buildStudentInput_(row, emptyText) {
  var e = (emptyText === undefined) ? '' : emptyText;
  return '授業内容：'       + (row[COL.LEARNED]    || e) +
         '\n分かったこと：'   + (row[COL.UNDERSTOOD] || e) +
         '\n難しかったこと：' + (row[COL.DIFFICULT]  || e) +
         '\n自己評価：'       + (row[COL.SELF_EVAL]  || e);
}

/** 「授業設定」シートから指定日の文脈を取得（シートが無くても落ちない） */
function getLessonContext_(ss, targetDate, defaultText) {
  var configSheet = ss.getSheetByName('授業設定');
  if (!configSheet) return defaultText;
  var configData = configSheet.getDataRange().getValues();
  for (var j = 1; j < configData.length; j++) {
    if (toDateKey_(configData[j][0]) === targetDate) {
      return configData[j][1] || defaultText;
    }
  }
  return defaultText;
}

/* =====================================================================
 *  OpenAI API 共通
 *  スクリプトプロパティ：
 *    OPENAI_API_KEY          … APIキー（必須）
 *    OPENAI_MODEL            … 使用モデル（未設定なら gpt-4o-mini）
 *    OPENAI_REASONING_EFFORT … 推論モデルの推論の強さ（未設定なら low）
 * ===================================================================== */

var OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
var DEFAULT_MODEL = 'gpt-4o-mini';
var DEFAULT_REASONING_EFFORT = 'low';

/** 使用モデル名（スクリプトプロパティ OPENAI_MODEL） */
function getModel_() {
  return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL') || DEFAULT_MODEL;
}

/** 推論モデル（GPT-5系以降・oシリーズ）かどうか */
function isReasoningModel_(model) {
  return /^(gpt-([5-9]|\d{2,})|o\d)/.test(model);
}

/**
 * APIリクエストを組み立てる（UrlFetchApp.fetchAll にそのまま渡せる形）
 * opts: { model, temperature, reasoningEffort, jsonMode }
 *  - 推論モデル：reasoning_effort を指定し、temperature は送らない
 *  - 従来モデル：temperature を指定
 *  - jsonMode：true なら JSON 形式で返させる（メッセージ内に「JSON」の語が必要）
 */
function buildOpenAiRequest_(messages, opts) {
  opts = opts || {};
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEYが設定されていません。');

  var model = opts.model || getModel_();
  var body = { model: model, messages: messages };
  if (isReasoningModel_(model)) {
    body.reasoning_effort = opts.reasoningEffort
      || props.getProperty('OPENAI_REASONING_EFFORT')
      || DEFAULT_REASONING_EFFORT;
  } else if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  return {
    url: OPENAI_ENDPOINT,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true   // エラー時も応答本文を読んで原因を表示するため
  };
}

/** APIの応答から本文を取り出す（エラーなら理由付きで例外を投げる） */
function parseOpenAiResponse_(res) {
  var code = res.getResponseCode();
  var text = res.getContentText();
  var json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error('APIの応答を解析できません（HTTP ' + code + '）');
  }
  if (code !== 200) {
    var msg = (json.error && json.error.message) ? json.error.message : text.substring(0, 200);
    throw new Error('APIエラー（HTTP ' + code + '）：' + msg);
  }
  var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('APIの応答が空でした。');
  return String(content).trim();
}

/** 1件呼び出す */
function callOpenAI_(messages, opts) {
  var res = UrlFetchApp.fetchAll([buildOpenAiRequest_(messages, opts)])[0];
  return parseOpenAiResponse_(res);
}

/* =====================================================================
 *  Webアプリ
 * ===================================================================== */

function doGet(e) {
  var template = HtmlService.createTemplateFromFile('index');
  template.isTeacher = isTeacherUser_();
  template.classList = CLASS_LIST;
  return template.evaluate()
    .setTitle('Re:Point')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * ログイン中のユーザーのレコードを返す（個人用：名前あり）
 */
function getUserRecords() {
  var target = getActiveEmail_();
  var data = getAnswerData_();
  var out = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowEmail = (row[COL.EMAIL] || '').toString().trim().toLowerCase();
    if (rowEmail !== target) continue;

    var ts = row[COL.TIMESTAMP];
    out.push({
      timestamp: ts instanceof Date
        ? Utilities.formatDate(ts, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm')
        : String(ts),
      classNo:        normalizeClass_(row[COL.CLASS_NO]),
      name:           getNameByClass_(row),
      learned:        String(row[COL.LEARNED]         || ''),
      understood:     String(row[COL.UNDERSTOOD]      || ''),
      difficult:      String(row[COL.DIFFICULT]       || ''),
      selfEval:       String(row[COL.SELF_EVAL]       || ''),
      aiCoach:        String(row[COL.AI_COACH]        || ''),
      status:         String(row[COL.GEN_STATUS]      || ''),
      teacherComment: String(row[COL.TEACHER_COMMENT] || '')
    });
  }
  return out;
}

/* =====================================================================
 *  クラスの広場
 * ===================================================================== */

/**
 * 生徒が指定日に提出した行から、その日のクラスを求める
 * （その日に提出していなければ ''。複数提出がある場合は最後の提出を採用）
 */
function findOwnClassOnDate_(data, email, targetDate) {
  var found = '';
  for (var i = 1; i < data.length; i++) {
    var rowEmail = (data[i][COL.EMAIL] || '').toString().trim().toLowerCase();
    if (rowEmail === email && toDateKey_(data[i][COL.TIMESTAMP]) === targetDate) {
      found = normalizeClass_(data[i][COL.CLASS_NO]);
    }
  }
  return found;
}

/** 広場に表示するAIコーチ欄の文言 */
function plazaCoachText_(row) {
  var status = String(row[COL.GEN_STATUS] || '');
  if (status === GEN_STATUS.PENDING) return 'コメント準備中';
  if (status === GEN_STATUS.ERROR) return '（コメントはありません）';
  return String(row[COL.AI_COACH] || '作成中...');
}

/**
 * 【広場用】指定日・指定クラスの振り返りを「完全匿名」で取得する
 *  - 生徒：自分が提出した日だけ閲覧可。クラスは自分の提出から自動決定（引数 classNo は無視）
 *  - 教師：任意の日付・クラスを閲覧可（classNo 必須）
 */
function getClassReflectionsForStudents(targetDate, classNo) {
  if (!isValidDateKey_(targetDate)) throw new Error('日付の指定が正しくありません。');

  var email = getActiveEmail_();
  var isTeacher = isTeacherUser_();
  var data = getAnswerData_();
  var targetClass;

  if (isTeacher) {
    targetClass = normalizeClass_(classNo);
    if (CLASS_LIST.indexOf(targetClass) === -1) throw new Error('クラスを選択してください。');
  } else {
    targetClass = findOwnClassOnDate_(data, email, targetDate);
    if (!targetClass) throw new Error('この日の広場は表示できません（自分が提出した日だけ見ることができます）。');
  }

  var out = [];
  var anonymousCounter = 1;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (toDateKey_(row[COL.TIMESTAMP]) !== targetDate) continue;
    if (normalizeClass_(row[COL.CLASS_NO]) !== targetClass) continue;

    // 氏名・メールアドレスは返さない
    out.push({
      name:           '生徒 ' + anonymousCounter,
      learned:        String(row[COL.LEARNED]         || '未入力'),
      understood:     String(row[COL.UNDERSTOOD]      || '未入力'),
      difficult:      String(row[COL.DIFFICULT]       || '未入力'),
      aiCoach:        plazaCoachText_(row),
      teacherComment: String(row[COL.TEACHER_COMMENT] || '未入力')
    });
    anonymousCounter++;
  }

  return { date: targetDate, classNo: targetClass, records: out };
}

/**
 * 【広場用：日付取得】生徒は自分が提出した日だけ、教師は全提出日
 */
function getPlazaAvailableDates() {
  var target = getActiveEmail_();
  var isTeacher = isTeacherUser_();
  var data = getAnswerData_();
  var datesObj = {};

  for (var i = 1; i < data.length; i++) {
    var key = toDateKey_(data[i][COL.TIMESTAMP]);
    if (!key) continue;
    if (isTeacher) {
      datesObj[key] = true;
    } else {
      var rowEmail = (data[i][COL.EMAIL] || '').toString().trim().toLowerCase();
      if (rowEmail === target) datesObj[key] = true;
    }
  }
  return Object.keys(datesObj).sort(function(a, b) { return a > b ? -1 : 1; });
}

/* =====================================================================
 *  教師専用
 * ===================================================================== */

/**
 * 【教師専用】分析ログ用：すべての提出された日付を取得する
 */
function getTeacherAvailableDates() {
  if (!isTeacherUser_()) throw new Error('権限がありません。');
  var data = getAnswerData_();
  var datesObj = {};
  for (var i = 1; i < data.length; i++) {
    var key = toDateKey_(data[i][COL.TIMESTAMP]);
    if (key) datesObj[key] = true;
  }
  return Object.keys(datesObj).sort(function(a, b) { return a > b ? -1 : 1; });
}

/**
 * フォーム送信時（AIコーチ回答）
 * 授業の文脈（lessonContext）を自動取得してAIに渡す
 */
function onFormSubmit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_ANSWERS) return;

  var row  = e.range.getRow();
  var data = e.values; // 文字列の配列（列の並びはシートと同じ）

  // 【フェーズ2】遅延生成モード：ここではAIを呼ばず「待機」にするだけ
  if (getCoachMode_() === 'delayed') {
    sheet.getRange(row, colNo_(COL.GEN_STATUS)).setValue(GEN_STATUS.PENDING);
    PropertiesService.getScriptProperties().setProperty('AI_PENDING', String(Date.now()));
    return;
  }

  // 従来モード（setupPhase2 を実行するまではこちら）
  var targetDate = '';
  if (data[COL.TIMESTAMP]) {
    try {
      targetDate = toDateKey_(new Date(data[COL.TIMESTAMP]));
    } catch (err) {
      targetDate = toDateKey_(data[COL.TIMESTAMP]);
    }
  }

  var lessonContext = getLessonContext_(getSpreadsheet_(), targetDate, '技術科の授業');
  var studentInput = buildStudentInput_(data, '未入力');

  try {
    var comment = generateAiCommentWithContext_(studentInput, lessonContext);
    sheet.getRange(row, colNo_(COL.AI_COACH)).setValue(comment);
  } catch (err) {
    sheet.getRange(row, colNo_(COL.AI_COACH)).setValue('エラー：' + err.message);
  }
}

/**
 * 【教師専用】O列に文脈付きで先生コメント素案を作成
 */
function generateTeacherDraftsBulk(targetDate) {
  if (!isTeacherUser_()) throw new Error('権限がありません。');

  var ss = getSpreadsheet_();
  var lessonContext = getLessonContext_(ss, targetDate, '本時の詳細は未設定です。');

  var sheet = ss.getSheetByName(SHEET_ANSWERS);
  var data = sheet.getDataRange().getValues();
  var count = 0;

  for (var i = 1; i < data.length; i++) {
    if (toDateKey_(data[i][COL.TIMESTAMP]) !== targetDate) continue;
    try {
      var draft = generateAiTeacherDraftWithContext_(buildStudentInput_(data[i], ''), lessonContext);
      sheet.getRange(i + 1, colNo_(COL.TEACHER_DRAFT)).setValue(draft);
      count++;
    } catch (e) {}
  }
  return count + ' 名分の素案作成完了。文脈：' + String(lessonContext).substring(0, 20) + '...';
}

/**
 * 教師向け：文脈を考慮したコメント素案の生成
 */
function generateAiTeacherDraftWithContext_(studentInput, lessonContext, model) {
  return callOpenAI_(buildTeacherDraftMessages_(studentInput, lessonContext), { model: model, temperature: 0.5 });
}

function buildTeacherDraftMessages_(studentInput, lessonContext) {
  return [
      {
        role: 'system',
        content: `あなたは中学校の技術科の教師です。
生徒の授業の振り返りに対して、以下の【教師のコメントの傾向】と【返答例】に完全に一致するトーンで、先生が送るコメントの素案を作成してください。

【本日の授業のポイント（文脈）】
${lessonContext}

【教師のコメントの傾向（重要・厳守）】
1. 共感と受容：生徒が「難しかった」「分からなかった」と書いた場合、まずは「戸惑ったと思います」「最初は難しいですよね」と優しく受け止め、共感してください。
2. 禁止ワード：AI特有の過剰な褒め言葉や不自然に明るい励ましは禁止です。「期待しています」「素晴らしいですね」「すごいですね」「頑張ってください」は【絶対に使用しないでください】。
3. 落ち着いた結び：コメントの最後は「〜していきましょう」「〜できるといいですね」「〜してみましょう」といった、生徒と同じ目線で一緒に歩むような、落ち着いた丁寧な言葉で締めくくってください。
4. 短文・曖昧な記述への対応（重要）：「色々」「育て方」「特になし」など、記述が極端に短く具体性がない場合は、無理に内容を推測して当たり障りのない返答をしないでください。代わりに「何について理解できたのか、次こそは具体的に書いてくださいね」「『色々』の中身が具体的に書けるようになるといいですね」のように、次回以降の具体的な記述を促す指導のコメントにしてください。
5. 文字数：40字〜80字程度で簡潔にまとめてください。

【返答例】
入力：授業内容：アグリテックプロジェクト\n分かったこと：育て方\n難しかったこと：無い\n自己評価：B
出力：育て方の何について理解できたのか、次こそは具体的に書いてくださいね！

入力：授業内容：岡谷のピンチ\n分かったこと：色々\n難しかったこと：特にない\n自己評価：B
出力：「色々」の中身が具体的に書けるようになるといいですね。次回の振り返りを楽しみにしています。

入力：授業内容：地球の環境\n分かったこと：なし\n難しかったこと：なし\n自己評価：A
出力：わかったこと・わからなかったこと、どちらもないというのは少し寂しいですね。次回は授業での気づきを一つでも書けると良いですね。

入力：授業内容：定植、育てる基礎知識\n分かったこと：肥料はあげすぎたらダメだということ、食べ物を育てるにはいろいろなたくさんの工夫が必要だという事を知った。\n難しかったこと：肥料にもたくさんの効果があってそれぞれの葉っぱの状況によって使い分けないといけないということが難しかった。\n自己評価：A
出力：肥料の使い方は確かに奥が深いですが、工夫が必要という点をしっかり捉えられています。あとは実際の栽培で知識を活用していきましょう。

===
以上の傾向と例を踏まえ、提示された生徒の振り返りに対する教師のコメントを出力してください。余計な挨拶などは含めず、コメントの本文のみを出力してください。`
      },
      { role: 'user', content: studentInput }
  ];
}

/**
 * 生徒向け：文脈を考慮したAIコーチのコメント生成
 */
function generateAiCommentWithContext_(studentInput, lessonContext, model) {
  return callOpenAI_(buildAiCoachMessages_(studentInput, lessonContext), { model: model, temperature: 0.6 });
}

function buildAiCoachMessages_(studentInput, lessonContext) {
  return [
      {
        role: 'system',
        content: `あなたは中学校の技術科の学習をサポートする「AIコーチ」です。
生徒が記入した授業の振り返りに対して、次の【対話のルール】を厳守し、生徒のモチベーションを高める伴走コメントを返してください。

【本日の授業のポイント（文脈）】
${lessonContext}

【対話のルール】
1. キャラクター：親しみやすく前向きで、中学生（1〜3年生）に分かりやすい言葉を使う「AIの伴走者」です。先生のような上からの「指導・評価」ではなく、生徒の気づきを「肯定・応援」する立場をとってください。
2. 的外れなアドバイスの禁止：何でもかんでも「ネットや本で詳しく調べてみましょう」「専門的な事例を考えましょう」といった、授業の範囲を超えたハードルの高いアドバイスや、文章からの的外れな推測は絶対にしないでください。アドバイスをする場合は、「身の回りの製品を観察してみよう」「次の時間の作業で意識してみよう」など、学校生活や次の授業で実践できる身近な内容に留めてください。
3. 短文・曖昧な記述への対応：生徒の入力が「色々」「特になし」「育て方」など極端に短く具体性がない場合、内容を無理に推測して適当に褒めるのはやめてください。代わりに「どんなことが色々あったのかな？次の時間にぜひ教えてね！」「難しいことがなかったのは順調な証拠だね！次は気づいたことを一つ書いてみてね」など、責めずに次の入力を優しく促す問いかけにしてください。
4. 文末と長さ：3文以内（100文字程度）で簡潔にまとめてください。丁寧な敬語（です・ます調）をベースにしつつ、親しみやすさを出すために「〜だね！」「〜してみよう！」といった表現を適度に変えて使用してください。`
      },
      { role: 'user', content: studentInput }
  ];
}

function getClassSummary(targetDate) {
  if (!isTeacherUser_()) throw new Error('権限がありません。');
  var ss = getSpreadsheet_();
  var data = ss.getSheetByName(SHEET_ANSWERS).getDataRange().getValues();
  var classReflections = [];
  for (var i = 1; i < data.length; i++) {
    if (toDateKey_(data[i][COL.TIMESTAMP]) === targetDate) {
      classReflections.push({
        understood: String(data[i][COL.UNDERSTOOD] || ''),
        difficult:  String(data[i][COL.DIFFICULT]  || '')
      });
    }
  }
  if (classReflections.length === 0) return null;
  var currentCount = classReflections.length;
  var logSheet = ss.getSheetByName('分析ログ') || ss.insertSheet('分析ログ');
  if (logSheet.getLastRow() === 0) logSheet.appendRow(['対象日', '人数', '分析結果', '実行日時']);
  var logData = logSheet.getDataRange().getValues();
  var cachedAdvice = null;
  var logRowIndex = -1;
  for (var j = 1; j < logData.length; j++) {
    if (toDateKey_(logData[j][0]) === targetDate) {
      if (logData[j][1] === currentCount) cachedAdvice = logData[j][2];
      logRowIndex = j + 1;
      break;
    }
  }
  var advice = cachedAdvice || generateClassAdvice_(targetDate, classReflections);
  if (!cachedAdvice) {
    if (logRowIndex > 0) logSheet.getRange(logRowIndex, 2, 1, 3).setValues([[currentCount, advice, new Date()]]);
    else logSheet.appendRow([targetDate, currentCount, advice, new Date()]);
  }
  return { date: targetDate, count: currentCount, reflections: classReflections, advice: advice, isCached: !!cachedAdvice };
}

function generateClassAdvice_(date, reflections) {
  var combinedText = reflections.map(function(r) {
    return '・わかった: ' + r.understood + ' / 難しかった: ' + r.difficult;
  }).join('\n');
  var messages = [
    { role: 'system', content: '中学校の学年主任を支えるアナリストとして簡潔に分析してください。' },
    { role: 'user', content: date + ' の一覧：\n' + combinedText }
  ];
  return callOpenAI_(messages, { temperature: 0.5 });
}

/**
 * 【教師専用】生徒向けAIコーチ回答（M列）を一括再生成
 */
function bulkReEvaluate(targetDate) {
  if (!isTeacherUser_()) throw new Error('権限がありません。');

  var ss = getSpreadsheet_();
  var lessonContext = getLessonContext_(ss, targetDate, '技術科の授業');

  var sheet = ss.getSheetByName(SHEET_ANSWERS);
  var data = sheet.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (toDateKey_(data[i][COL.TIMESTAMP]) !== targetDate) continue;
    try {
      var comment = generateAiCommentWithContext_(buildStudentInput_(data[i], ''), lessonContext);
      sheet.getRange(i + 1, colNo_(COL.AI_COACH)).setValue(comment);
      count++;
    } catch (e) {}
  }
  return count + ' 件の再評価が完了しました。';
}

/* =====================================================================
 *  モデル比較テスト（教師専用・GASエディタから実行）
 *  回答シートには書き込まず、「モデル比較」シートに結果を出力する
 * ===================================================================== */

/** 比較の設定（ここを書き換えてから runModelComparison を実行） */
var COMPARE_CONFIG = {
  TARGET_DATE:  '',               // 'yyyy/MM/dd'。空なら最新の提出日
  MODEL_A:      'gpt-4o-mini',    // 現行モデル
  MODEL_B:      'gpt-6-luna',     // 移行候補
  MAX_STUDENTS: 10                // 比較する人数（多すぎると時間がかかる）
};

/** 先生コメント素案の禁止ワード（プロンプトと同じもの） */
var DRAFT_FORBIDDEN_WORDS = ['期待しています', '素晴らしいですね', 'すごいですね', '頑張ってください'];

/** GASエディタから実行する入口 */
function runModelComparison() {
  var msg = compareModels_(
    COMPARE_CONFIG.TARGET_DATE,
    COMPARE_CONFIG.MODEL_A,
    COMPARE_CONFIG.MODEL_B,
    COMPARE_CONFIG.MAX_STUDENTS
  );
  Logger.log(msg);
  return msg;
}

function compareModels_(targetDate, modelA, modelB, maxStudents) {
  if (!isTeacherUser_()) throw new Error('権限がありません。');

  var ss = getSpreadsheet_();
  var data = ss.getSheetByName(SHEET_ANSWERS).getDataRange().getValues();

  // 対象日（未指定なら最新の提出日）
  if (!targetDate) {
    for (var d = 1; d < data.length; d++) {
      var k = toDateKey_(data[d][COL.TIMESTAMP]);
      if (k && k > targetDate) targetDate = k;
    }
  }
  if (!isValidDateKey_(targetDate)) throw new Error('対象日が正しくありません：' + targetDate);

  // 対象の行
  var rows = [];
  for (var i = 1; i < data.length && rows.length < maxStudents; i++) {
    if (toDateKey_(data[i][COL.TIMESTAMP]) === targetDate) rows.push(data[i]);
  }
  if (rows.length === 0) throw new Error(targetDate + ' の提出がありません。');

  var coachContext = getLessonContext_(ss, targetDate, '技術科の授業');
  var draftContext = getLessonContext_(ss, targetDate, '本時の詳細は未設定です。');

  // 比較ケース：各生徒 × {AIコーチ, 先生素案}
  var cases = [];
  rows.forEach(function(row) {
    cases.push({ row: row, type: 'AIコーチ',
                 messages: buildAiCoachMessages_(buildStudentInput_(row, '未入力'), coachContext), temperature: 0.6 });
    cases.push({ row: row, type: '先生素案',
                 messages: buildTeacherDraftMessages_(buildStudentInput_(row, ''), draftContext), temperature: 0.5 });
  });

  // モデルごとに並列実行して所要時間を計測
  var runModel = function(model) {
    var requests = cases.map(function(c) {
      return buildOpenAiRequest_(c.messages, { model: model, temperature: c.temperature });
    });
    var t0 = Date.now();
    var responses = UrlFetchApp.fetchAll(requests);
    var sec = (Date.now() - t0) / 1000;
    var outputs = responses.map(function(res) {
      try { return parseOpenAiResponse_(res); } catch (e) { return '【エラー】' + e.message; }
    });
    return { sec: sec, outputs: outputs };
  };
  var resultA = runModel(modelA);
  var resultB = runModel(modelB);

  // 禁止ワードの検出（先生素案のみ）
  var checkForbidden = function(type, text) {
    if (type !== '先生素案') return '';
    return DRAFT_FORBIDDEN_WORDS.filter(function(w) { return text.indexOf(w) !== -1; }).join('、');
  };

  // 結果シートに出力（氏名は出さない）
  var sheet = ss.getSheetByName('モデル比較') || ss.insertSheet('モデル比較');
  sheet.clear();
  sheet.getRange(1, 1, 2, 6).setValues([
    ['対象日', targetDate, '実行日時', new Date(), '人数', rows.length],
    ['A：' + modelA + ' 一括処理時間(秒)', resultA.sec, 'B：' + modelB + ' 一括処理時間(秒)', resultB.sec, '', '']
  ]);

  var header = ['No', 'クラス', '種別', '学習内容', '分かったこと', '難しかったこと', '自己評価',
                'A：' + modelA, 'A文字数', 'A禁止ワード',
                'B：' + modelB, 'B文字数', 'B禁止ワード'];
  var body = cases.map(function(c, idx) {
    var a = resultA.outputs[idx];
    var b = resultB.outputs[idx];
    return [
      Math.floor(idx / 2) + 1,
      normalizeClass_(c.row[COL.CLASS_NO]),
      c.type,
      c.row[COL.LEARNED], c.row[COL.UNDERSTOOD], c.row[COL.DIFFICULT], c.row[COL.SELF_EVAL],
      a, a.length, checkForbidden(c.type, a),
      b, b.length, checkForbidden(c.type, b)
    ];
  });
  sheet.getRange(4, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sheet.getRange(5, 1, body.length, header.length).setValues(body).setWrap(true).setVerticalAlignment('top');
  sheet.setFrozenRows(4);
  [4, 5, 6, 8, 11].forEach(function(col) { sheet.setColumnWidth(col, col >= 8 ? 320 : 180); });

  return targetDate + ' の ' + rows.length + ' 名分（' + cases.length + ' 件）を比較しました。' +
         'A ' + resultA.sec + '秒 / B ' + resultB.sec + '秒。「モデル比較」シートを確認してください。';
}

/* =====================================================================
 *  【フェーズ1】単元テーマの推定＋新しいAIコーチ（試行）
 *  - 回答シートには書き込まない。結果は「フェーズ1試行」シートに出力する
 *  - ここで定義する関数はフェーズ2（遅延生成）でもそのまま使う
 * ===================================================================== */

/** 試行の設定（ここを書き換えてから runPhase1Trial を実行） */
var PHASE1_CONFIG = {
  TARGET_DATE: ''   // 'yyyy/MM/dd'。空なら最新の提出日
};

/** 文脈の種類（Q列に記録する値。フェーズ2で使用） */
var CONTEXT_SOURCE = {
  FIXED:  '確定',
  INFER:  '推定',
  LESSON: '授業設定のみ',
  NONE:   '手がかりなし'
};

/** 今日の記述だけで推定するのに必要な人数（スクリプトプロパティで変更可） */
function getThemeMinSubmissions_() {
  var v = parseInt(PropertiesService.getScriptProperties().getProperty('THEME_MIN_SUBMISSIONS'), 10);
  return isNaN(v) ? 3 : v;
}

/** 「授業設定」シートからその日の学習内容を取得（なければ ''） */
function getLessonRecord_(ss, dateKey) {
  var rec = getLessonContext_(ss, dateKey, '');
  return rec ? String(rec).trim() : '';
}

/** 指定日・指定クラスの行を集める */
function collectClassRows_(data, dateKey, classNo) {
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (toDateKey_(data[i][COL.TIMESTAMP]) !== dateKey) continue;
    if (normalizeClass_(data[i][COL.CLASS_NO]) !== classNo) continue;
    rows.push(data[i]);
  }
  return rows;
}

/** 指定クラスについて、指定日より前で最も新しい提出日を返す（なければ ''） */
function findPreviousDate_(data, dateKey, classNo) {
  var prev = '';
  for (var i = 1; i < data.length; i++) {
    var k = toDateKey_(data[i][COL.TIMESTAMP]);
    if (!k || k >= dateKey) continue;
    if (normalizeClass_(data[i][COL.CLASS_NO]) !== classNo) continue;
    if (k > prev) prev = k;
  }
  return prev;
}

/** 文字列を指定の長さで切る */
function clip_(v, max) {
  var s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.substring(0, max) + '…' : s;
}

/** JSONを寛容に解析する（コードブロックや前後の文字を取り除く） */
function parseJsonLoose_(text) {
  var s = String(text || '').replace(/```(json)?/g, '');
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSONが見つかりません');
  return JSON.parse(s.substring(start, end + 1));
}

/* ---------------------------------------------------------------------
 *  単元テーマの推定
 * --------------------------------------------------------------------- */

/**
 * 推定用のメッセージ
 * p: { rows, lessonRecord, previousTheme }
 */
function buildThemeMessages_(p) {
  var list = p.rows.slice(0, 40).map(function(r, i) {
    return (i + 1) + '. 学習内容：' + clip_(r[COL.LEARNED], 80) +
           ' ／ 分かったこと：' + clip_(r[COL.UNDERSTOOD], 120);
  }).join('\n');

  var system =
`あなたは中学校の技術分野の授業を支援するアシスタントです。
同じクラスの生徒が書いた今日の授業の振り返りから、このクラスが取り組んでいる「単元の課題」を推定してください。

【前提】
- 教科は中学校の技術分野（材料と加工の技術、生物育成の技術、エネルギー変換の技術、情報の技術）
- 先生が記録した本時の学習内容がある場合は、それを最も信頼できる手がかりとして扱う

【推定のルール】
- theme は「何を使って、何をする単元か」が分かるように1〜2文で書く
- 入力に出てこない固有名詞や数値は書かない
- 記述がばらばらで絞れないときは confidence を "low" にする
- 前回のテーマが与えられた場合、今日の記述が同じ単元の続きかどうかを sameUnitAsPrevious で答える。前回のテーマがない場合は false

【出力】
次のJSONだけを出力する。
{"theme": "…", "sameUnitAsPrevious": true または false, "confidence": "high" または "low"}`;

  var user =
    '先生が記録した本時の学習内容：' + (p.lessonRecord || 'なし') + '\n' +
    '前回のテーマ：' + (p.previousTheme || 'なし') + '\n' +
    '今日の振り返り（' + p.rows.length + '人）：\n' + (list || 'なし');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function buildThemeRequest_(p, model) {
  return buildOpenAiRequest_(buildThemeMessages_(p), { model: model, jsonMode: true, temperature: 0.2 });
}

/** 推定結果を解析（失敗したら confidence:low 扱い） */
function parseThemeResponse_(res) {
  try {
    var j = parseJsonLoose_(parseOpenAiResponse_(res));
    return {
      theme: String(j.theme || '').trim(),
      sameUnitAsPrevious: j.sameUnitAsPrevious === true,
      confidence: j.confidence === 'high' ? 'high' : 'low',
      error: ''
    };
  } catch (e) {
    return { theme: '', sameUnitAsPrevious: false, confidence: 'low', error: e.message };
  }
}

/**
 * 使う文脈を決める
 * p: { fixedTheme, inferred, todayCount, lessonRecord }
 * 戻り値: { source, theme, lessonRecord }
 */
function resolveContext_(p) {
  var lessonRecord = p.lessonRecord || '';
  if (p.fixedTheme) {
    return { source: CONTEXT_SOURCE.FIXED, theme: p.fixedTheme, lessonRecord: lessonRecord };
  }
  var inf = p.inferred;
  var enough = p.todayCount >= getThemeMinSubmissions_() || (inf && inf.sameUnitAsPrevious);
  if (inf && inf.theme && inf.confidence === 'high' && enough) {
    return { source: CONTEXT_SOURCE.INFER, theme: inf.theme, lessonRecord: lessonRecord };
  }
  if (lessonRecord) {
    return { source: CONTEXT_SOURCE.LESSON, theme: '', lessonRecord: lessonRecord };
  }
  return { source: CONTEXT_SOURCE.NONE, theme: '', lessonRecord: '' };
}

/* ---------------------------------------------------------------------
 *  用語集（中学校学習指導要領 技術分野の内容A〜Dと「技術の見方・考え方」から）
 *  - 「用語集」シートがあればそれを使い、なければ下の既定値を使う
 *  - シートを作るには setupGlossarySheet を一度実行する（以後はシートで編集）
 *  - AIには、生徒の振り返りに出てきた用語の説明だけを渡す
 * --------------------------------------------------------------------- */

var SHEET_GLOSSARY = '用語集';

/** [用語, 別の書き方（「、」区切り）, 説明] */
var DEFAULT_GLOSSARY = [
  // 技術の見方・考え方
  ['技術の見方・考え方', '見方・考え方', '社会からの要求、安全性、環境負荷、経済性などに着目して、技術を最適化すること。'],
  ['最適化', '最適な', 'いくつかの条件のバランスを考えて、目的に最も合う方法を選ぶこと。'],
  ['トレードオフ', '', 'ある条件をよくすると、別の条件が悪くなってしまう関係。例：性能を上げると費用が増える。'],
  ['環境負荷', '環境への影響、環境への負担', '技術を使うことで自然環境に与える影響。'],
  ['経済性', '費用、コスト、お金', '費用をおさえて実現したり、使い続けたりできるかどうか。'],
  // A 材料と加工の技術
  ['材料の特性', '木材、金属、プラスチック', '木材・金属・プラスチックなど、材料ごとに強さ・重さ・加工のしやすさなどの性質が異なること。'],
  ['丈夫な構造', '構造、補強、三角形', '三角形の骨組みや、補強材を入れることで、形が変わりにくく丈夫になる。'],
  ['鉄筋コンクリート', '', 'コンクリートは押される力に強く、鉄筋は引っ張られる力に強い。組み合わせて互いの弱点を補った材料。'],
  ['等角図', '', '立体を、幅・高さ・奥行きの3方向を同じ割合で、斜めから見たように表した図。'],
  ['第三角法', '三面図', '正面図・平面図・右側面図などを決まった位置に並べて、立体を平面に表す製図の方法。'],
  // B 生物育成の技術
  ['育成環境', '生育環境、栽培環境', '光・温度・水・土・肥料など、生物の成長に影響する条件。気象・土壌・生物（病害虫など）の要因がある。'],
  ['肥料の三要素', '肥料', '植物の成長に特に必要な窒素・リン酸・カリのこと。与えすぎると成長に悪い影響が出る。'],
  // C エネルギー変換の技術
  ['エネルギー変換', 'エネルギー変換の技術、エネルギー転換、変換', 'エネルギーをある形から別の形に変えること。例：光→電気（太陽光発電）、電気→光（LED）、電気→動き（モーター）。'],
  ['発電', '電気をつくる、電気を作る', '光・熱・水や風の動きなどのエネルギーを、電気エネルギーに変えること。'],
  ['再生可能エネルギー', '再生エネルギー、自然エネルギー', '太陽光・風力・水力・地熱など、自然の中でくり返し利用できるエネルギー。'],
  ['太陽光発電', 'ソーラーパネル、太陽電池', '太陽の光のエネルギーを、直接電気に変える発電の方法。'],
  ['変換効率', '効率、エネルギー損失', 'もとのエネルギーのうち、目的のエネルギーに変えられた割合。残りは熱などとして失われる。'],
  ['蓄電', '充電、電池、バッテリー、ためる', '電気エネルギーを電池などにためておき、必要なときに取り出して使うこと。'],
  ['電気回路', '回路', '電源・負荷（電気を使うもの）・導線・スイッチなどをつないだ、電流の通り道。'],
  ['LED', '発光ダイオード', '電気を光に変える半導体の部品。少ない電力で明るく光る。'],
  ['動力伝達', '歯車、ベルト、リンク機構、カム、機構', '歯車・ベルト・リンク機構・カムなどで、運動の向きや速さを変えて伝える仕組み。'],
  ['保守点検', '点検、メンテナンス', '機器を安全に長く使うために、定期的に点検し、手入れをすること。'],
  ['漏電・感電', '漏電、感電', '漏電は電気が本来の通り道以外に流れること。感電は人の体に電流が流れること。'],
  // D 情報の技術
  ['情報の技術', '情報技術、情報', '情報を集め、処理し、記録し、伝える技術。例：センサーで計測、コンピュータで処理、通信で伝える。'],
  ['デジタル化', 'デジタル', '文字・音・画像などの情報を、0と1の組み合わせで表すこと。'],
  ['センサー', 'センサ', '光・温度・水位・動きなどの変化をとらえ、電気信号に変える部品。'],
  ['計測・制御', '計測、制御', 'センサーで状態を計測し、その情報をもとにコンピュータが判断して、モーターなどの機器を動かす仕組み。'],
  ['アクチュエータ', 'モーター、ブザー', 'モーターやブザーなど、コンピュータの命令で実際に動いたり、音や光を出したりする部品。'],
  ['プログラム', 'プログラミング', 'コンピュータに実行させる処理の手順を書いたもの。順次・分岐・反復を組み合わせて表す。'],
  ['順次・分岐・反復', '順次、分岐、反復、条件分岐、くり返し', '順次は順番に実行、分岐は条件によって処理を変える、反復は同じ処理をくり返すこと。'],
  ['情報通信ネットワーク', 'ネットワーク、インターネット、通信', 'コンピュータなどの機器をつなぎ、情報をやりとりできるようにした仕組み。'],
  ['双方向性のあるコンテンツ', '双方向、コンテンツ', '使う人の操作や入力に応じて反応が返ってくる、ネットワークを利用した作品。例：チャットや投票の仕組み。'],
  ['情報セキュリティ', 'セキュリティ', '情報を、のぞき見・書きかえ・消失などから守るための対策。'],
  ['情報モラル', 'モラル', '情報社会で適切に活動するための、もとになる考え方や態度。'],
  ['システム', '', 'いくつかの要素が組み合わさり、目的のために働くまとまり。']
];

/** 用語集シートを作る（既にある場合は何もしない）。GASエディタから一度実行する */
function setupGlossarySheet() {
  var ss = getSpreadsheet_();
  if (ss.getSheetByName(SHEET_GLOSSARY)) return '「' + SHEET_GLOSSARY + '」シートは既にあります。';
  var sheet = ss.insertSheet(SHEET_GLOSSARY);
  sheet.getRange(1, 1, 1, 3).setValues([['用語', '別の書き方（「、」区切り）', '説明']]).setFontWeight('bold');
  sheet.getRange(2, 1, DEFAULT_GLOSSARY.length, 3).setValues(DEFAULT_GLOSSARY);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(3, 520);
  sheet.setFrozenRows(1);
  return '「' + SHEET_GLOSSARY + '」シートを作成しました（' + DEFAULT_GLOSSARY.length + '語）。';
}

/** 用語集を読み込む（シートがなければ既定値） */
function loadGlossary_(ss) {
  var rows = DEFAULT_GLOSSARY;
  var sheet = ss.getSheetByName(SHEET_GLOSSARY);
  if (sheet && sheet.getLastRow() > 1) {
    rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  }
  return rows.filter(function(r) { return r[0] && r[2]; }).map(function(r) {
    var words = [String(r[0]).trim()].concat(
      String(r[1] || '').split(/[、,，]/).map(function(w) { return w.trim(); }).filter(String)
    );
    return { term: String(r[0]).trim(), words: words, desc: String(r[2]).trim() };
  });
}

/** 生徒の振り返りに出てくる用語だけを選ぶ */
function pickGlossaryForRow_(row, glossary) {
  var text = [row[COL.LEARNED], row[COL.UNDERSTOOD], row[COL.DIFFICULT]].join(' ');
  return (glossary || []).filter(function(g) {
    return g.words.some(function(w) { return w && text.indexOf(w) !== -1; });
  });
}

/* ---------------------------------------------------------------------
 *  新しいAIコーチ
 * --------------------------------------------------------------------- */

/** AIコーチ用の生徒入力（自己評価は含めない・氏名も含めない） */
function buildCoachStudentInput_(row) {
  return '学習内容：'           + (row[COL.LEARNED]    || '未入力') +
         '\n分かったこと：'       + (row[COL.UNDERSTOOD] || '未入力') +
         '\n難しかったこと：'     + (row[COL.DIFFICULT]  || '未入力');
}

/**
 * 新しいAIコーチのメッセージ
 * ctx: resolveContext_ の戻り値 / glossary: loadGlossary_ の戻り値
 */
function buildAiCoachMessagesV2_(row, ctx, glossary) {
  var noClue = (ctx.source === CONTEXT_SOURCE.NONE);

  var clues = noClue
    ? '授業の手がかり：なし（この授業の内容は分かりません）'
    : '単元の課題：' + (ctx.theme || '不明') + '\n' +
      '先生が記録した本時の学習内容：' + (ctx.lessonRecord || 'なし');

  var picked = pickGlossaryForRow_(row, glossary);
  var glossaryText = picked.length
    ? picked.map(function(g) { return '- ' + g.term + '：' + g.desc; }).join('\n')
    : '（この振り返りに関係する用語はありません）';

  var linkRules = noClue
    ? `2. 授業の内容が分からないため、授業内容の推測や技術的な説明はしない。生徒の気づきを受け止め、「どんな技術が使えそうかな？」のように考えを広げる問いかけで結ぶ。
3. 「難しかったこと」には共感を示すだけにとどめ、説明はしない。
4. 次の一歩を示す場合も、授業の内容を決めつけない問いかけにする。`
    : `2. 授業の課題とつなげる：「分かったこと」は、単元の課題にどうつながるかという視点で受け止める。生徒の記述が具体的な場合は、その内容に沿ってコメントし、技術名をつけ足さない。技術とのつながりを示すのは、記述が短い・あいまいで次の方向を示したいときだけにする。その場合も「情報の技術」「エネルギー変換の技術」のような総称を並べず、記述に合う具体的なもの（センサー、通知、発電、蓄電など）を1つだけ挙げる。
3. 「難しかったこと」の読み方：授業の活動の中での難しさとして解釈する。用語や仕組みが難しいと書かれていたら、【用語集】の説明に沿って一言のヒントを返す。
4. 次の一歩：単元の課題に沿った具体的な一歩を1つだけ示す。「身近なものを観察しよう」「身近な工夫を考えよう」「身の回りでできる備えを考えよう」のような、課題と関係の薄い一般的な助言はしない。具体例（通知、センサー、発電など）は生徒の記述に合うときだけ挙げ、記述に手がかりがなければ具体例を出さずに問いかけにする。単元の課題の文言（地域名と課題を組み合わせた言い回しなど）をそのままくり返さない。`;

  var system =
`あなたは中学校の技術分野の学習を支える「AIコーチ」です。
生徒が書いた授業の振り返りに対して、生徒に直接届くコメントを1つ返してください。

【授業の手がかり】
${clues}

【用語集】（先生が確認した説明。用語の意味を説明するときは必ずこれに沿う）
${glossaryText}

【コメントの書き方】
1. 立場：親しみやすく前向きな伴走者。先生のような評価や指導ではなく、生徒の気づきを受け止めて応援する。中学生に分かる言葉を使う。最初の文で、生徒の記述のよい点を具体的に1つ認める。ただし、記述がほとんどない場合や意味がつかめない場合は、無理にほめるところを探さず、振り返りを書いてくれたことを受け止める程度にする。
${linkRules}
5. 想像で書かない：授業で何をするか（実験、観察、機器の操作など）を勝手に決めて書かない。
6. 短い・あいまいな記述：「色々」「特になし」など具体性がない場合は、推測で褒めない。「読み取れない」「分かりにくい」のような評価する言い方は使わず、「次は〜を教えてね」と誘う形で、何が分かったのかを書くよう促す。
7. 自己評価（A・B・C）にはふれない。
8. 長さと文体：3文以内・120字以内（目安は80〜100字）。です・ます調を基本に「〜だね」「〜してみよう」を適度に混ぜる。毎回同じ書き出しや結びにしない。
9. ほめ言葉：「すばらしい」「すごい」は使わない。「大きな発見」「大きな一歩」「大切な気づき」などの決まり文句は使わない。何がよかったのかを、生徒の書いた内容に即して具体的に伝える。
10. ローマ字・誤字：ローマ字や誤字を、別の言葉や地名に読み替えない。地名を書くときは、生徒の記述か「授業の手がかり」にある表記をそのまま使う。意味がつかめない場合は内容に立ち入らず、次は日本語で書いてほしいとやさしく誘う。
11. 生徒の質問・知りたいこと：【用語集】や中学校の教科書レベルで確かに答えられることは一言で答える。市の取り組みなど地域の具体的なことは答えず、「先生に聞いてみよう」「調べてみよう」と調べ方を示す。
12. 記号：絵文字や「☆」などの飾りの記号は使わない。

【説明してよい範囲（厳守）】
- 用語の意味を説明するときは、【用語集】の説明に沿う。【用語集】にない用語の意味は説明しない。
- それ以外の補足に使ってよいのは、「授業の手がかり」に書かれていることと、中学校の教科書レベルで確実な基本的な仕組みだけ。
- 地域の具体的な事実（施設名、被害、歴史など）、数値、製品名、固有名詞は、生徒が書いたもの以外は出さない。
- 生徒の理解に明らかな誤りがあり、正しい内容に確信がある場合だけ、否定せずに正しい情報をやさしく添える。
- 確かでないことは断定せず、「次の時間に先生に聞いてみよう」などの問いかけにする。

【出力】
次のJSONだけを出力する。
{"comment": "生徒に届けるコメント本文", "hasExplanation": true または false, "hasQuestion": true または false}
hasExplanation は、用語の説明・仕組みの説明・誤りの補足など、事実の説明を含む場合に true にする。
hasQuestion は、生徒の振り返りに「知りたい」「どうなっているのか」などの質問や疑問が書かれている場合に true にする（コメントの内容ではなく、生徒の記述で判断する）。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: buildCoachStudentInput_(row) }
  ];
}

function buildAiCoachRequestV2_(row, ctx, model, glossary) {
  return buildOpenAiRequest_(buildAiCoachMessagesV2_(row, ctx, glossary), { model: model, jsonMode: true, temperature: 0.6 });
}

/** コメントから飾りの記号（☆★♪絵文字など）を取り除く */
function sanitizeComment_(s) {
  return String(s || '')
    .replace(/[☆★♪♫♡♥◎○●◇◆□■△▲▽▼※]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t　]+$/gm, '')
    .trim();
}

/** 確認の目印（R列に書く値） */
function buildCheckFlag_(r) {
  var flags = [];
  if (r.hasExplanation) flags.push('要確認');
  if (r.hasQuestion) flags.push('質問あり');
  return flags.join('・');
}

/** AIコーチの応答を解析（失敗時は例外） */
function parseAiCoachResponse_(res) {
  var j = parseJsonLoose_(parseOpenAiResponse_(res));
  var comment = sanitizeComment_(j.comment);
  if (!comment) throw new Error('コメントが空でした');
  return { comment: comment, hasExplanation: j.hasExplanation === true, hasQuestion: j.hasQuestion === true };
}

/* ---------------------------------------------------------------------
 *  フェーズ1の試行（GASエディタから runPhase1Trial を実行）
 * --------------------------------------------------------------------- */

function runPhase1Trial() {
  var msg = phase1Trial_(PHASE1_CONFIG.TARGET_DATE);
  Logger.log(msg);
  return msg;
}

function phase1Trial_(targetDate) {
  if (!isTeacherUser_()) throw new Error('権限がありません。');

  var ss = getSpreadsheet_();
  var data = ss.getSheetByName(SHEET_ANSWERS).getDataRange().getValues();

  if (!targetDate) {
    for (var d = 1; d < data.length; d++) {
      var k = toDateKey_(data[d][COL.TIMESTAMP]);
      if (k && k > targetDate) targetDate = k;
    }
  }
  if (!isValidDateKey_(targetDate)) throw new Error('対象日が正しくありません：' + targetDate);

  var lessonRecord = getLessonRecord_(ss, targetDate);
  var model = getModel_();
  var glossary = loadGlossary_(ss);

  // 対象日に提出があるクラス
  var classes = CLASS_LIST.map(function(c) {
    return { classNo: c, rows: collectClassRows_(data, targetDate, c) };
  }).filter(function(g) { return g.rows.length > 0; });
  if (classes.length === 0) throw new Error(targetDate + ' の提出がありません。');

  // ① 前回の授業のテーマ（本番では「単元テーマ」シートから読む。試行ではその場で推定する）
  classes.forEach(function(g) {
    g.prevDate = findPreviousDate_(data, targetDate, g.classNo);
    g.prevRows = g.prevDate ? collectClassRows_(data, g.prevDate, g.classNo) : [];
  });
  var prevTargets = classes.filter(function(g) { return g.prevRows.length > 0; });
  var prevRes = UrlFetchApp.fetchAll(prevTargets.map(function(g) {
    return buildThemeRequest_({ rows: g.prevRows, lessonRecord: getLessonRecord_(ss, g.prevDate), previousTheme: '' }, model);
  }));
  prevTargets.forEach(function(g, i) {
    var r = parseThemeResponse_(prevRes[i]);
    g.prevTheme = r.confidence === 'high' ? r.theme : '';
  });

  // ② 今日のテーマを推定
  var t0 = Date.now();
  var themeRes = UrlFetchApp.fetchAll(classes.map(function(g) {
    return buildThemeRequest_({ rows: g.rows, lessonRecord: lessonRecord, previousTheme: g.prevTheme || '' }, model);
  }));
  classes.forEach(function(g, i) {
    g.inferred = parseThemeResponse_(themeRes[i]);
    if (!g.prevTheme) g.inferred.sameUnitAsPrevious = false;   // 前回のテーマがなければ「同じ単元」は無効
    g.ctx = resolveContext_({ fixedTheme: '', inferred: g.inferred, todayCount: g.rows.length, lessonRecord: lessonRecord });
  });

  // ③ 全員分のコメントをまとめて生成
  var cases = [];
  classes.forEach(function(g) {
    g.rows.forEach(function(row) { cases.push({ g: g, row: row }); });
  });
  var coachRes = UrlFetchApp.fetchAll(cases.map(function(c) {
    return buildAiCoachRequestV2_(c.row, c.g.ctx, model, glossary);
  }));
  var sec = Math.round((Date.now() - t0) / 100) / 10;

  // ④ 結果を集計
  var reMijika = /身近|身の回り/;
  var reSelfEval = /自己評価|[ABC]評価|評価[ABC]|[ABC]の(手応え|自己)/;
  var rePraise = /すばらしい|素晴らしい|すごい|大きな発見|大きな一歩|大切な気づき/;
  var reGeneric = /(情報.{0,8}エネルギー|エネルギー.{0,8}情報)/;   // 技術の総称を並べた言い回し
  var stats = { oldMijika: 0, newMijika: 0, oldEval: 0, newEval: 0, oldPraise: 0, newPraise: 0, oldGeneric: 0, newGeneric: 0, over120: 0,
                check: 0, question: 0, error: 0 };

  var body = cases.map(function(c, idx) {
    var oldC = String(c.row[COL.AI_COACH] || '');
    var newC = '', flag = '';
    try {
      var r = parseAiCoachResponse_(coachRes[idx]);
      newC = r.comment;
      flag = buildCheckFlag_(r);
      if (r.hasExplanation) stats.check++;
      if (r.hasQuestion) stats.question++;
    } catch (e) {
      newC = '【エラー】' + e.message;
      stats.error++;
    }
    if (reMijika.test(oldC)) stats.oldMijika++;
    if (reMijika.test(newC)) stats.newMijika++;
    if (reSelfEval.test(oldC)) stats.oldEval++;
    if (reSelfEval.test(newC)) stats.newEval++;
    if (rePraise.test(oldC)) stats.oldPraise++;
    if (rePraise.test(newC)) stats.newPraise++;
    if (reGeneric.test(oldC)) stats.oldGeneric++;
    if (reGeneric.test(newC)) stats.newGeneric++;
    if (newC.length > 120) stats.over120++;
    return [
      idx + 1,
      classLabel_(c.g.classNo),
      c.row[COL.LEARNED], c.row[COL.UNDERSTOOD], c.row[COL.DIFFICULT],
      oldC,
      newC,
      newC.length,
      c.g.ctx.source,
      flag
    ];
  });

  // ⑤ 「フェーズ1試行」シートに出力（氏名・メールアドレスは出さない）
  var sheet = ss.getSheetByName('フェーズ1試行') || ss.insertSheet('フェーズ1試行');
  sheet.clear();

  var summary = [
    ['対象日', targetDate, '実行日時', new Date(), 'モデル', model],
    ['人数', cases.length, '生成時間(秒)', sec, '授業設定の記録', lessonRecord || 'なし'],
    ['「身近・身の回り」（現在→新）', stats.oldMijika + ' → ' + stats.newMijika,
     '自己評価への言及（現在→新）', stats.oldEval + ' → ' + stats.newEval,
     '決まり文句のほめ言葉（現在→新）', stats.oldPraise + ' → ' + stats.newPraise],
    ['要確認', stats.check, '質問あり', stats.question, 'エラー', stats.error],
    ['技術の総称を並べた言い回し（現在→新）', stats.oldGeneric + ' → ' + stats.newGeneric,
     '120字超え（新）', stats.over120, '用語集', glossary.length + '語']
  ];
  sheet.getRange(1, 1, summary.length, 6).setValues(summary);

  var themeHeader = [['クラス', '今日の人数', '前回の日付', '前回のテーマ（推定）', '今日の推定テーマ', '前回と同じ単元', '確かさ', '使う文脈']];
  var themeRows = classes.map(function(g) {
    return [
      classLabel_(g.classNo), g.rows.length, g.prevDate || 'なし', g.prevTheme || 'なし',
      g.inferred.theme || ('（推定できず）' + g.inferred.error),
      g.inferred.sameUnitAsPrevious ? 'はい' : 'いいえ',
      g.inferred.confidence, g.ctx.source
    ];
  });
  var themeTop = summary.length + 2;
  sheet.getRange(themeTop, 1, 1, 8).setValues(themeHeader).setFontWeight('bold');
  sheet.getRange(themeTop + 1, 1, themeRows.length, 8).setValues(themeRows).setWrap(true).setVerticalAlignment('top');

  var header = [['No', 'クラス', '学習内容', '分かったこと', '難しかったこと',
                 '現在のAIコーチ', '新しいAIコーチ', '文字数', '使った文脈', '確認の目印']];
  var top = themeTop + themeRows.length + 3;
  sheet.getRange(top, 1, 1, header[0].length).setValues(header).setFontWeight('bold');
  sheet.getRange(top + 1, 1, body.length, header[0].length).setValues(body).setWrap(true).setVerticalAlignment('top');
  sheet.setFrozenRows(0);
  [[3, 160], [4, 200], [5, 200], [6, 300], [7, 300]].forEach(function(w) { sheet.setColumnWidth(w[0], w[1]); });

  return targetDate + '：' + classes.length + 'クラス・' + cases.length + '件を試行しました（' + sec + '秒）。' +
         '「身近・身の回り」' + stats.oldMijika + '→' + stats.newMijika + '件、自己評価への言及 ' + stats.oldEval + '→' + stats.newEval +
         '件、決まり文句のほめ言葉 ' + stats.oldPraise + '→' + stats.newPraise +
         '件、要確認 ' + stats.check + '件、質問あり ' + stats.question + '件、エラー ' + stats.error + '件。「フェーズ1試行」シートを確認してください。';
}

/** クラス番号 → 表示名 */
function classLabel_(c) {
  return c === '桑の木' ? '桑の木' : c + '組';
}

/* =====================================================================
 *  【フェーズ2】遅延生成（提出の約5分後に、クラスごとにまとめて生成）
 *
 *  使い始め：GASエディタで setupPhase2 を一度実行する
 *    - 回答シートにP〜R列の見出しを付ける
 *    - 「単元テーマ」シートを作る
 *    - 1分ごとの定期実行（processPendingComments）を登録する
 *    - スクリプトプロパティ AI_COACH_MODE を delayed にする
 *  元に戻す：stopPhase2 を実行する（従来の「提出直後に生成」に戻る）
 *
 *  スクリプトプロパティ（任意）
 *    AI_WAIT_MINUTES       … 最初の提出から生成までの待ち時間（既定 5）
 *    THEME_MIN_SUBMISSIONS … 今日の記述だけで推定するのに必要な人数（既定 3）
 *    AI_MAX_RETRY          … エラー時の試行回数の上限（既定 3）
 * ===================================================================== */

var SHEET_THEME = '単元テーマ';
var THEME_COL = { DATE: 0, CLASS: 1, INFERRED: 2, FIXED: 3, SAME_UNIT: 4, COUNT: 5, UPDATED: 6 };
var THEME_HEADER = ['日付', 'クラス', '推定テーマ', '確定テーマ（違うときだけ先生が書く）', '前回と同じ単元', '根拠の人数', '更新日時'];
var ANSWER_EXTRA_HEADER = ['生成状態', '使った文脈', '確認の目印'];
var MAX_ROWS_PER_RUN = 60;   // 1回の実行で生成する上限（GASの実行時間を守るため）

/** 'delayed'（遅延生成）または 'legacy'（従来どおり提出直後に生成） */
function getCoachMode_() {
  return PropertiesService.getScriptProperties().getProperty('AI_COACH_MODE') === 'delayed' ? 'delayed' : 'legacy';
}

function getIntProp_(key, def) {
  var v = parseInt(PropertiesService.getScriptProperties().getProperty(key), 10);
  return isNaN(v) ? def : v;
}

/* ---------------------------------------------------------------------
 *  セットアップ／停止（GASエディタから実行）
 * --------------------------------------------------------------------- */

function setupPhase2() {
  if (!isTeacherUser_()) throw new Error('権限がありません。');
  var ss = getSpreadsheet_();
  var msgs = [];

  // ① 回答シートのP〜R列に見出し（既に別の内容があれば中止）
  var ans = ss.getSheetByName(SHEET_ANSWERS);
  var hdrRange = ans.getRange(1, colNo_(COL.GEN_STATUS), 1, 3);
  var hdr = hdrRange.getValues()[0];
  var empty = hdr.every(function(v) { return v === '' || v === null; });
  var same = hdr.join('|') === ANSWER_EXTRA_HEADER.join('|');
  if (!empty && !same) {
    throw new Error('回答シートのP〜R列に既に別の内容があります（' + hdr.join(' / ') + '）。列を確認してください。');
  }
  if (empty) { hdrRange.setValues([ANSWER_EXTRA_HEADER]).setFontWeight('bold'); msgs.push('回答シートにP〜R列の見出しを追加'); }

  // ② 単元テーマシート
  if (!ss.getSheetByName(SHEET_THEME)) { getThemeSheet_(ss); msgs.push('「' + SHEET_THEME + '」シートを作成'); }

  // ③ 1分ごとの定期実行
  var exists = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'processPendingComments';
  });
  if (!exists) {
    ScriptApp.newTrigger('processPendingComments').timeBased().everyMinutes(1).create();
    msgs.push('1分ごとの定期実行を登録');
  }

  // ④ モード切り替え
  PropertiesService.getScriptProperties().setProperty('AI_COACH_MODE', 'delayed');
  msgs.push('遅延生成モードに切り替え');

  var msg = 'フェーズ2を開始しました：' + msgs.join('、') + '。';
  Logger.log(msg);
  return msg;
}

function stopPhase2() {
  if (!isTeacherUser_()) throw new Error('権限がありません。');
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processPendingComments') ScriptApp.deleteTrigger(t);
  });
  PropertiesService.getScriptProperties().setProperty('AI_COACH_MODE', 'legacy');
  var pending = countByStatus_(GEN_STATUS.PENDING);
  var msg = '従来モード（提出直後に生成）に戻しました。' +
            (pending ? '待機中の行が ' + pending + ' 件残っています。processAllPendingNow を実行すると生成できます。' : '');
  Logger.log(msg);
  return msg;
}

/** 待ち時間を無視して、待機中の行をすべて今すぐ生成する（動作確認用・停止前の処理用） */
function processAllPendingNow() {
  if (!isTeacherUser_()) throw new Error('権限がありません。');
  var msg = processPendingComments(true);
  Logger.log(msg);
  return msg;
}

/** 生成状態の件数（確認用） */
function countByStatus_(status) {
  var data = getAnswerData_();
  var n = 0;
  for (var i = 1; i < data.length; i++) if (String(data[i][COL.GEN_STATUS]) === status) n++;
  return n;
}

/** 動作確認用：待機・エラーの件数をログに出す */
function showPhase2Status() {
  var msg = 'モード：' + getCoachMode_() +
            ' ／ 待機 ' + countByStatus_(GEN_STATUS.PENDING) + '件' +
            ' ／ エラー ' + countByStatus_(GEN_STATUS.ERROR) + '件' +
            ' ／ 待機の印：' + (PropertiesService.getScriptProperties().getProperty('AI_PENDING') ? 'あり' : 'なし');
  Logger.log(msg);
  return msg;
}

/* ---------------------------------------------------------------------
 *  単元テーマシート
 * --------------------------------------------------------------------- */

function getThemeSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_THEME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(SHEET_THEME);
  sheet.getRange(1, 1, 1, THEME_HEADER.length).setValues([THEME_HEADER]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3, 420);
  sheet.setColumnWidth(4, 320);
  return sheet;
}

function findThemeIndex_(values, dateKey, classNo) {
  for (var i = 1; i < values.length; i++) {
    if (toDateKey_(values[i][THEME_COL.DATE]) === dateKey &&
        normalizeClass_(values[i][THEME_COL.CLASS]) === classNo) return i;
  }
  return -1;
}

/** 同じクラスで、指定日より前の最も新しい行（テーマが空の行は飛ばす） */
function findPrevThemeIndex_(values, dateKey, classNo) {
  var best = -1, bestKey = '';
  for (var i = 1; i < values.length; i++) {
    var k = toDateKey_(values[i][THEME_COL.DATE]);
    if (!k || k >= dateKey) continue;
    if (normalizeClass_(values[i][THEME_COL.CLASS]) !== classNo) continue;
    if (!values[i][THEME_COL.FIXED] && !values[i][THEME_COL.INFERRED]) continue;
    if (k > bestKey) { bestKey = k; best = i; }
  }
  return best;
}

/* ---------------------------------------------------------------------
 *  定期実行の本体（1分ごと）
 * --------------------------------------------------------------------- */

/**
 * 待機中の行を、日付×クラスごとにまとめて生成する
 * force が true のときは待ち時間を無視する（processAllPendingNow から）
 */
function processPendingComments(force) {
  force = (force === true);   // 定期実行からはイベントが渡るので true にはならない
  var props = PropertiesService.getScriptProperties();
  if (!force && !props.getProperty('AI_PENDING')) return '待機中の提出はありません。';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return '別の処理が実行中です。';
  try {
    var startedAt = Date.now();
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName(SHEET_ANSWERS);
    var data = sheet.getDataRange().getValues();

    // ① 待機中の行を日付×クラスでまとめる
    var groups = {}, order = [], totalPending = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][COL.GEN_STATUS]) !== GEN_STATUS.PENDING) continue;
      totalPending++;
      var dateKey = toDateKey_(data[i][COL.TIMESTAMP]);
      var cls = normalizeClass_(data[i][COL.CLASS_NO]);
      var key = dateKey + '|' + cls;
      if (!groups[key]) { groups[key] = { date: dateKey, cls: cls, rows: [], oldest: Infinity }; order.push(key); }
      groups[key].rows.push(i);
      var t = data[i][COL.TIMESTAMP] instanceof Date ? data[i][COL.TIMESTAMP].getTime() : new Date(data[i][COL.TIMESTAMP]).getTime();
      if (!isNaN(t) && t < groups[key].oldest) groups[key].oldest = t;
    }
    if (totalPending === 0) { clearPendingFlag_(props, startedAt); return '待機中の提出はありません。'; }

    // ② 生成してよいクラスを選ぶ（最初の提出から一定時間たった or その日のテーマが既にある）
    var themeSheet = getThemeSheet_(ss);
    var themeValues = themeSheet.getDataRange().getValues();
    var waitMs = getIntProp_('AI_WAIT_MINUTES', 5) * 60000;
    var now = Date.now();
    var ready = [], rowBudget = MAX_ROWS_PER_RUN;
    order.forEach(function(key) {
      var g = groups[key];
      g.themeIdx = findThemeIndex_(themeValues, g.date, g.cls);
      var hasTheme = g.themeIdx > 0 &&
        (themeValues[g.themeIdx][THEME_COL.FIXED] || themeValues[g.themeIdx][THEME_COL.INFERRED]);
      var ok = force || hasTheme || g.oldest === Infinity || (now - g.oldest >= waitMs);
      if (ok && rowBudget > 0) {
        g.rows = g.rows.slice(0, rowBudget);
        rowBudget -= g.rows.length;
        g.hasTheme = !!hasTheme;
        ready.push(g);
      }
    });
    if (ready.length === 0) return '待ち時間中のクラスがあります（' + totalPending + '件待機）。';

    var model = getModel_();
    var glossary = loadGlossary_(ss);
    ready.forEach(function(g) { g.lessonRecord = getLessonRecord_(ss, g.date); });

    // ③ テーマがまだないクラスは推定する（同じ日・同じクラスの全員分の記述を使う）
    var needInfer = ready.filter(function(g) { return !g.hasTheme; });
    needInfer.forEach(function(g) {
      g.allRows = collectClassRows_(data, g.date, g.cls);
      var pi = findPrevThemeIndex_(themeValues, g.date, g.cls);
      g.prevTheme = pi > 0 ? String(themeValues[pi][THEME_COL.FIXED] || themeValues[pi][THEME_COL.INFERRED]) : '';
      g.prevFixed = pi > 0 ? String(themeValues[pi][THEME_COL.FIXED] || '') : '';
    });
    var inferRes = needInfer.length ? UrlFetchApp.fetchAll(needInfer.map(function(g) {
      return buildThemeRequest_({ rows: g.allRows, lessonRecord: g.lessonRecord, previousTheme: g.prevTheme }, model);
    })) : [];
    needInfer.forEach(function(g, k) {
      var r = parseThemeResponse_(inferRes[k]);
      if (!g.prevTheme) r.sameUnitAsPrevious = false;
      var ctx = resolveContext_({ fixedTheme: '', inferred: r, todayCount: g.allRows.length, lessonRecord: g.lessonRecord });
      var carried = (r.sameUnitAsPrevious && g.prevFixed) ? g.prevFixed : '';   // 前回の確定テーマを引き継ぐ
      var vals = [g.date, g.cls, ctx.source === CONTEXT_SOURCE.INFER ? r.theme : '', carried,
                  r.sameUnitAsPrevious ? 'はい' : 'いいえ', g.allRows.length, new Date()];
      if (g.themeIdx > 0) {
        themeSheet.getRange(g.themeIdx + 1, 1, 1, vals.length).setValues([vals]);
        themeValues[g.themeIdx] = vals;
      } else {
        themeSheet.appendRow(vals);
        themeValues.push(vals);
        g.themeIdx = themeValues.length - 1;
      }
    });

    // ④ 使う文脈を決める（確定 → 推定 → 授業設定のみ → 手がかりなし）
    ready.forEach(function(g) {
      var tv = themeValues[g.themeIdx] || [];
      var fixed = String(tv[THEME_COL.FIXED] || '');
      var inferred = String(tv[THEME_COL.INFERRED] || '');
      if (fixed)               g.ctx = { source: CONTEXT_SOURCE.FIXED,  theme: fixed,    lessonRecord: g.lessonRecord };
      else if (inferred)       g.ctx = { source: CONTEXT_SOURCE.INFER,  theme: inferred, lessonRecord: g.lessonRecord };
      else if (g.lessonRecord) g.ctx = { source: CONTEXT_SOURCE.LESSON, theme: '',       lessonRecord: g.lessonRecord };
      else                     g.ctx = { source: CONTEXT_SOURCE.NONE,   theme: '',       lessonRecord: '' };
    });

    // ⑤ コメントをまとめて生成し、書き込む
    var cases = [];
    ready.forEach(function(g) { g.rows.forEach(function(i) { cases.push({ g: g, i: i }); }); });
    var res = UrlFetchApp.fetchAll(cases.map(function(c) {
      return buildAiCoachRequestV2_(data[c.i], c.g.ctx, model, glossary);
    }));

    var maxRetry = getIntProp_('AI_MAX_RETRY', 3);
    var done = 0, failed = 0, retry = 0;
    cases.forEach(function(c, k) {
      var rowNo = c.i + 1;
      try {
        var r = parseAiCoachResponse_(res[k]);
        sheet.getRange(rowNo, colNo_(COL.AI_COACH)).setValue(r.comment);
        sheet.getRange(rowNo, colNo_(COL.GEN_STATUS), 1, 3).setValues([[GEN_STATUS.DONE, c.g.ctx.source, buildCheckFlag_(r)]]);
        done++;
      } catch (e) {
        var m = String(data[c.i][COL.CHECK_FLAG] || '').match(/^再試行:(\d+)/);
        var n = (m ? parseInt(m[1], 10) : 0) + 1;
        if (n >= maxRetry) {
          sheet.getRange(rowNo, colNo_(COL.GEN_STATUS), 1, 3).setValues([[GEN_STATUS.ERROR, c.g.ctx.source, 'エラー：' + e.message]]);
          failed++;
        } else {
          sheet.getRange(rowNo, colNo_(COL.GEN_STATUS), 1, 3).setValues([[GEN_STATUS.PENDING, '', '再試行:' + n]]);
          retry++;
        }
      }
    });

    // ⑥ 待機中の行がなくなったら「待機あり」の印を消す
    var remaining = totalPending - done - failed;
    if (remaining <= 0) clearPendingFlag_(props, startedAt);

    return ready.length + 'クラス・' + cases.length + '件を処理：生成 ' + done + '件、再試行待ち ' + retry +
           '件、エラー ' + failed + '件。残りの待機 ' + remaining + '件。';
  } finally {
    lock.releaseLock();
  }
}

/** 処理開始より後に新しい提出がなければ「待機あり」の印を消す */
function clearPendingFlag_(props, startedAt) {
  var f = props.getProperty('AI_PENDING');
  if (f && Number(f) <= startedAt) props.deleteProperty('AI_PENDING');
}
