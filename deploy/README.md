# Ubuntu + Nginx 部署

当前项目使用 Node 内置模块提供 DeepSeek 后端代理，Nginx 负责静态文件和 `/api/` 反向代理。以下命令在 Ubuntu 22.04 服务器执行。

## 1. 安装 Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo apt install -y nodejs
```

## 2. 上传项目

把项目文件上传到服务器目录：

```text
/var/www/zaotu/
```

目录中至少应包含 `index.html`、`styles.css`、`server.js`、`.env` 和 `assets/`。`.env` 中设置 `DEEPSEEK_API_KEY`，不要提交到 Git。服务会在项目目录下创建 `data/projects.json` 保存项目状态，并将上传的商品图片写入 `data/uploads/`，请确保运行 Node 服务的用户对 `data/` 具有读写权限。

## 3. 配置站点

把 `zaotu.conf.example` 上传到：

```text
/etc/nginx/sites-available/zaotu
```

将其中的 `example.com` 替换为实际域名，然后执行：

```bash
sudo ln -s /etc/nginx/sites-available/zaotu /etc/nginx/sites-enabled/zaotu
sudo nginx -t
sudo systemctl reload nginx
```

如果服务器默认站点占用了 80 端口，可以移除默认配置的软链接：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 4. 启动 Node 服务

先在项目目录确认接口可用：

```bash
node server.js
curl http://127.0.0.1:5173/api/health
```

生产环境建议使用 systemd 或 PM2 保持 Node 服务运行，Nginx 配置中的 `/api/` 会转发到 `127.0.0.1:5173`，上传图片通过 `/uploads/` 由 Node 服务提供。项目数据和图片暂存于项目目录的 `data/`，正式多人使用前应迁移到数据库和对象存储，并增加登录鉴权。

## 5. 访问检查

浏览器打开服务器公网 IP，确认页面能正常显示。也可以检查：

```bash
curl -I http://你的域名/health.html
```

正式上线前再配置域名解析、ICP 备案和 HTTPS。当前配置只负责 HTTP 预览，证书配置应在备案和域名确认后加入。
