import { defineConfig } from 'vite'

// 直接双击 dist/index.html 打开时，module 脚本和 crossorigin 的样式会被浏览器拦掉，
// 所以构建产物改成相对路径 + 普通 defer 脚本
function fileOpenFriendly() {
  return {
    name: 'file-open-friendly',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue
        file.source = String(file.source)
          .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script defer src="$1"></script>')
          .replace(/<link rel="stylesheet" crossorigin href/, '<link rel="stylesheet" href')
      }
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [fileOpenFriendly()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true
  }
})
