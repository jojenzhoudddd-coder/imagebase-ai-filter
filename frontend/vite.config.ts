import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    // Manual chunk splitting —— 把 vendor 大库切到单独 chunk,主 bundle 只剩
    // 应用代码。第三方库变更频率远低于业务,split 后浏览器缓存命中率显著提高;
    // 而且多 chunk 可以并行下载,首屏不再被一个 1.2MB blob 卡住。
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          // React 全家桶 —— 几乎所有页面都要,单独成 chunk 长效缓存
          if (id.match(/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/)) {
            return "vendor-react";
          }
          // Markdown 渲染栈 —— IdeaEditor + ChatSidebar 都用到,但只有这俩用
          if (id.match(/node_modules[\\/](react-markdown|remark-.*|rehype-.*|micromark.*|mdast-.*|hast-.*|unist-.*|unified|vfile.*|character-entities.*|decode-named-character-reference|trim-lines|space-separated-tokens|comma-separated-tokens|property-information|html-url-attributes|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp)[\\/]/)) {
            return "vendor-markdown";
          }
          // CodeMirror —— IdeaEditor source 模式才用,可以独立缓存
          if (id.match(/node_modules[\\/](@codemirror|@lezer|codemirror|@uiw[\\/]react-codemirror)[\\/]/)) {
            return "vendor-codemirror";
          }
          // Vega 系列 —— 在 ChatChartBlock 里 dynamic import,绝对不能合到主
          // vendor。返回 undefined 让 vite 按 import 关系自然分块（保留它独立
          // 的 chunk,在显示图表时才拉）。所有 vega-* / d3-* / topojson-* / fast-deep-equal
          // 等常被 vega 拽出来的传递依赖都走这条路。
          if (id.match(/node_modules[\\/](vega.*|d3-.*|topojson-.*|fast-deep-equal|fast-json-stable-stringify)[\\/]/)) {
            return undefined;
          }
          // 其它 vendor —— 默认归到 vendor 通用 chunk(避免太多小 chunk 增加 HTTP 开销)
          return "vendor";
        },
      },
    },
    // 把警告阈值从 500 拉到 800,避免每次 build 都报警(我们已经在主动拆 chunk)
    chunkSizeWarningLimit: 800,
  },
});
