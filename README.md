# R2 视频站

基于 Cloudflare Workers + R2 的自托管视频网站，浏览器内转码 HLS 多清晰度，支持多用户与分类，无需服务器和数据库。

## 部署

需要已开通 R2 的 Cloudflare 账号和 Node.js 22+：
```bash
git clone https://github.com/zhushili/r2-video-site.git && cd r2-video-site
./install.sh    # Windows：npm run setup
```

脚本会依次完成登录、创建存储桶、设置管理员密码和部署；重复运行即可更新，线上设置与数据保持不变。

| 命令 | 用途 |
| --- | --- |
| `./install.sh --yes` | 沿用现有设置直接更新 |
| `./install.sh --reset-password` | 重设管理员密码 |
| `./install.sh --dry-run` | 只检查，不部署 |
| `npm run deploy:ci` | Workers Builds 的部署命令，推送到 main 自动上线 |

## 本地开发

```bash
npm install && echo "ADMIN_PASSWORD=dev-password" > .dev.vars && npm run dev
```

## 许可证

[MIT](LICENSE)
