export const DEEPSEEK_SECRET_ID = "deepseek-translator-deepseek-api-key";
export const MISTRAL_SECRET_ID = "deepseek-translator-mistral-api-key";

export const DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinkingEnabled: true,
  reasoningEffort: "max",
  temperature: 0.2,
  maxTokens: 100000,
  outputSuffix: "_翻译",

  mistralApiKey: "",
  mistralModel: "mistral-ocr-latest",
  pdfOutputMode: "same-folder",
  movePdfToSubfolder: false,
  keepOcrMarkdown: false,
  extractImages: true,
  imageLimit: 0,
  imageMinSize: 0,
  paginate: true,
  deleteMistralFile: true,

  translationPrompt: `下面请把我提供的 Markdown 文档翻译成简体中文。

要求：
1. 只输出翻译后的Markdown格式正文，不要添加解释、前言或代码围栏等。
2. 层级结构：我的这个文档是通过第三方工具由pdf转写而来的，它是一页一页分别转写的，因此标题的层级结构可能较为混乱、并不统一，很多不是标题的内容也被识别为了标题，你翻译之前需要先理解原文，并在此基础上推测出正确的层级结构，计划好一个一致的层级结构，然后翻译时按照这个给出（例如如果你识别到这是书籍的某一章，且里面包含1.5,1.5.2这样的层级，你就把类似1.5这样的统一用二级标题，1.5.2这样的统一用三级标题等；以及如果1.5和1.6之间有大于它们层级的标题，那多半是有问题的，就需要改正）
3. 脚注结构：对于里面的脚注，你需要把它们统一改为obsidian中的脚注格式(即插入的地方输入[^脚注标号]，然后再整个文档末尾补上[^脚注标号]: 脚注的内容，注意我要去把所有脚注都移动到整个文档末尾而非每页末尾）
4. 分页结构：你需要识别出并去掉所有分页分割线、分割线前后的页眉页脚页数等内容，然后如果检测到上下两页是一个连续段落被分开，你需要重新合起来
5. 原文中可能有个别数学符号直接用特殊符号而非markdown格式表示的（例如用的θ而非$\\theta$），这种你也要都改成markdown表示
6. 除了以上需要你修改的结构，其他结构、格式上的东西一律保持原状，不得擅自更改（尤其是引用图片的链接不要动，以及原文的加粗等文字格式要保留）
7. 除了上面提到的修改，内容上也不要进行任何删减、篡改等，你要做的只是翻译！
8. 术语和符号：关键术语在中文后面在括号中用斜体标注原英文（即两边分别加*，主要是定理名字，数学名词等，平凡的词汇如“引理”“练习”等不用翻译）；新给出的关键定义、定理等名字要加粗（即两边分别加**，注意仅限于加粗名字）
注意关键术语翻译时一定根据论文语境确定译文，并确保全文使用的译文一致`,
};
