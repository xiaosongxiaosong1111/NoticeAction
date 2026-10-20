# 服务器部署说明

本项目的默认运行方式是 Windows 本机（`127.0.0.1` + DPAPI 凭据）。本目录下的配置用于把它部署到 Linux 服务器，并在公网通过 HTTPS 访问。

## 部署架构

```
浏览器 ──HTTPS(8084, Let's Encrypt)──> Nginx ──HTTP──> 127.0.0.1:43173 (Node, systemd)
          │                                │
          └── 80 端口: ACME 验证 + 跳转      └── /api/parse ──HTTPS──> TextIn xParse
```

访问地址：

- **https://47.120.19.14:8084**
- **https://47-120-19-14.sslip.io:8084**

- `47-120-19-14.sslip.io` 是 sslip.io 提供的免费 DNS，自动解析到 `47.120.19.14`，无需购买域名。
- Let's Encrypt 证书同时覆盖域名和公网 IP，两种 HTTPS 地址均通过浏览器信任校验。
- 访问 `http://47.120.19.14:8084` 会自动跳转到对应的 HTTPS 地址。

## 服务器环境

- Alibaba Cloud Linux 3（兼容 RHEL 8），2 核 / 1.8G
- Node.js 22.23.3 → `/opt/node22`
- 应用目录 → `/opt/noticeaction`，运行用户 → `notice`
- 环境变量 → `/etc/noticeaction.env`（600）
- systemd → `/etc/systemd/system/noticeaction.service`
- Nginx 站点 → `/www/server/panel/vhost/nginx/noticeaction.conf`（8084）与 `noticeaction-acme.conf`（80）
- Certbot 5.8 → `/opt/certbot-ip/`（系统自带的 1.22 不支持 IP 证书）
- Let's Encrypt 组合证书 → `/etc/letsencrypt/live/noticeaction-ip/`
- IP 的 HTTP-01 路由 → `/www/server/panel/vhost/nginx/well-known/47.120.19.14.conf`
- 续期 → `certbot-renew.timer` 调用新版 Certbot，续期后由 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` 重载 Nginx

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。保持 `127.0.0.1`，由 Nginx 反代 |
| `PORT` | `43173` | 监听端口 |
| `ALLOWED_HOSTS` | 空 | 追加允许的 Host（逗号分隔）。当前值：`47.120.19.14,47-120-19-14.sslip.io`。`127.0.0.1` / `localhost` 始终允许 |
| `TEXTIN_APP_ID` | 空 | TextIn AppID |
| `TEXTIN_SECRET_CODE` | 空 | TextIn Secret Code |

> Linux 上没有 Windows DPAPI，页面里的"解析设置"不可用。凭据通过环境变量注入，修改后执行 `systemctl restart noticeaction`。

## 常用命令

```bash
systemctl status noticeaction      # 查看状态
systemctl restart noticeaction     # 重启
journalctl -u noticeaction -f      # 查看日志
nginx -t && systemctl reload nginx # 校验并重载 Nginx
tail -f /www/wwwlogs/noticeaction.error.log
```

## 更新代码

```bash
# 本地打包（排除 .git 与 artifacts）
tar -czf noticeaction.tar.gz --exclude=notice-action-demo/.git --exclude=notice-action-demo/artifacts -C <父目录> notice-action-demo

# 上传后
tar -xzf /tmp/noticeaction.tar.gz -C /opt/noticeaction --strip-components=1
chown -R notice:notice /opt/noticeaction
systemctl restart noticeaction
```

## 重新开启访问密码（可选）

当前部署未启用 Basic Auth，任何知道地址的人都能访问。如需恢复密码保护：

```bash
printf 'notice:%s\n' "$(openssl passwd -apr1 '新密码')" > /etc/nginx/.htpasswd_notice
chmod 644 /etc/nginx/.htpasswd_notice
```

然后在 `noticeaction.conf` 的 `server {` 内加上：

```nginx
auth_basic "NoticeAction";
auth_basic_user_file /etc/nginx/.htpasswd_notice;
```

执行 `nginx -t && systemctl reload nginx`。

## 证书管理

```bash
/opt/certbot-ip/bin/certbot certificates    # 查看证书与到期时间
/opt/certbot-ip/bin/certbot renew --dry-run # 续期演练
/opt/certbot-ip/bin/certbot renew           # 手动续期
systemctl list-timers | grep certbot        # 查看自动续期定时器
```

IP 证书使用 Let's Encrypt `shortlived` 配置，有效期约 160 小时。`certbot-renew.timer` 每天检查两次，成功续期后自动重载 Nginx。正式部署必须保留自动续期，不能依赖人工更新。

## 安全说明

- 应用本身没有账号体系，当前页面无访问密码。
- `/api/parse` 按来源 IP 限制为平均每分钟 20 次、允许 20 次突发请求；不影响单次活动最多 20 份材料的正常顺序解析。
- 组合证书的 SAN 同时包含 `47-120-19-14.sslip.io` 和 `47.120.19.14`，通过域名或 IP 访问均不会出现证书名称不匹配。
- 阿里云安全组需要放行 `8084/TCP` 和 `80/TCP`；未放行时外网无法访问或无法续期。
- 已增加 NoticeAction 专用 SSH 密钥；确认应急登录方式后，建议禁用 root 密码登录。
