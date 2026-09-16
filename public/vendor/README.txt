vendor/ —— 第三方前端库（直接以 <script> 引入，不参与打包）

alphaTab.js
  alphaTab，谱面模式（index.html）的渲染与播放引擎。
  仅在谱面模式页面加载。

pdf.min.js / pdf.worker.min.js
  Mozilla pdf.js（pdfjs-dist 3.11.174，Apache-2.0）。
  供图片谱模式「加载谱图」导入 PDF 吉他谱时使用，按需动态加载
  （见 js/image-tab.js 的 loadPdfLib），不进 Service Worker 预缓存清单。

  重新取包：
    npm i -D pdfjs-dist@3.11.174
    cp node_modules/pdfjs-dist/build/pdf.min.js        public/vendor/
    cp node_modules/pdfjs-dist/build/pdf.worker.min.js public/vendor/

sonivox.sf3 / font/Bravura.*
  alphaTab 的音色库与乐谱字体。
