# Burner-X 纯前端部署版

本目录由用户提供的 Burner-X-main.zip 整理而来，保留原有 LICENSE、NOTICE 和 README。
这是静态 HTML/CSS/JS 网站；不使用 Vite 构建，不部署 Express、本地代理、管理员后台或数据库。
首页默认使用 frontend 模式（localStorage / IndexedDB），首页和落地页不再加载后端登录探测脚本。

## 部署步骤

1. 解压 Burner-X-frontend.zip。
2. 将 Burner-X-frontend 文件夹放到现有 Burner-X GitHub 仓库根目录，提交并推送。
   不需要删除原仓库任何目录。
3. 从 https://vercel.com/new 重新导入该仓库。
   不要继续使用先前 URL 中带 framework=services 的多服务导入链接。
4. 把 Root Directory（根目录）设置为 Burner-X-frontend。
5. Framework Preset 选择 Other。Build Command 为空，Install Command 为空，
   Output Directory 显式填写一个点 `.`（这里不是 public，也不是 dist）。
   本目录中的 vercel.json 已声明这些设置。
6. Environment Variables 不需要填写，点击 Deploy。
7. 部署状态为 Ready 后打开访问地址，检查首页、落地页和历史记录页面。

也可建立一个独立的 GitHub 仓库，将本目录内的全部文件放在仓库根目录；
此时 Vercel 的 Root Directory 使用 `.`。

## 部署配置

只公开静态页面及资源，没有 services 名称、内部服务、/api 后端或 bindings。
未添加 SPA 兜底重写，因为本项目使用多个真实 HTML 文件。

## 功能边界

无需登录；历史、配置和术语库存储在当前浏览器。
AI 翻译等功能仍需在网页设置中配置相应服务的 API Key。
MinerU / Doc2X OCR 及部分学术检索功能按原项目设计需要独立 HTTPS 代理/Worker；
本包没有部署代理，不代表所有外部接口已经开通。原 workers/ 和 local-proxy/ 代码保存在原始压缩包中。
不需要将 API Key 写入静态代码，也不需要填写数据库、JWT 等后端变量。

## 验证范围

打包时检查了 HTML 中本地脚本、样式表及图片的文件引用，检查了纯前端存储初始化。
未发布到 Vercel，未使用真实 API Key 测试 OCR/翻译，未验证第三方 CDN 的实际网络可达性。
