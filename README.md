# 酒馆后台通知

这是一个给手机和后台切换场景准备的 SillyTavern 后台生成方案：

- `server plugin` 负责在服务端创建后台任务，即使浏览器切到后台也继续生成
- `third-party extension` 负责在前端拦截兼容的生成请求，把任务转交给 server plugin
- 生成完成后可以二选一使用 `Bark` 或 `Web Push` 提示
- 重新回到酒馆页面时，结果会自动同步回当前聊天

## 当前能力

- 接管单角色聊天里的普通回复和重新生成
- 浏览器切后台后继续生成
- 按设置选择 `Bark` 或 `网页通知`
- 提供前后端调试日志开关，方便排查订阅、发送和同步问题
- 返回酒馆页面后自动同步后台结果

## 当前限制

- 目前只接管 `normal` 和 `regenerate` 的单聊流程
- `群聊`、`重抽`、`继续生成`、`扮演` 等流程仍走 SillyTavern 原生逻辑
- 后台任务和 Web Push 待发送队列保存在进程内存里，服务重启后未完成任务会丢失
- Web Push 依赖 HTTPS 和浏览器通知权限；iPhone / iPad 通常还需要加入主屏幕后再从图标打开

## 目录结构

1. [server/index.mjs](/Users/zorroki/VsCodeProjects/tavern-notify/server/index.mjs)
   负责后台任务、Bark 发送、Web Push 订阅与发送
2. [server/sw.js](/Users/zorroki/VsCodeProjects/tavern-notify/server/sw.js)
   Web Push Service Worker，负责把空推送转成真正的网页通知
3. [index.js](/Users/zorroki/VsCodeProjects/tavern-notify/index.js)、[settings.html](/Users/zorroki/VsCodeProjects/tavern-notify/settings.html)、[style.css](/Users/zorroki/VsCodeProjects/tavern-notify/style.css)
   负责前端设置、通知渠道切换、后台任务接管和状态同步

## 安装

### 1. 安装 server plugin

把这个仓库克隆到 SillyTavern 的 `plugins` 目录，例如：

```text
SillyTavern/plugins/tavern-notify
```

并确保 `config.yaml` 已启用 server plugin：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: true
```

### 2. 安装前端扩展

这个仓库根目录已经是标准第三方扩展结构，包含：

- [manifest.json](/Users/zorroki/VsCodeProjects/tavern-notify/manifest.json)
- [index.js](/Users/zorroki/VsCodeProjects/tavern-notify/index.js)
- [settings.html](/Users/zorroki/VsCodeProjects/tavern-notify/settings.html)
- [style.css](/Users/zorroki/VsCodeProjects/tavern-notify/style.css)

可以直接在 SillyTavern 扩展管理里通过仓库地址安装。

如果手工放文件，目标目录仍然是：

```text
SillyTavern/public/scripts/extensions/third-party/tavern-notify
```

### 3. 重启 SillyTavern

重启酒馆服务或 Docker 容器，让 plugin 和 extension 一起加载。

## 配置

打开扩展设置里的 `酒馆后台通知`，按顺序配置：

1. 打开 `启用单聊后台接管`
2. 如果需要排查问题，可以打开 `开启调试日志`
3. 在 `通知方式` 里选择 `Bark` 或 `网页通知`
4. 如果选的是 `Bark`
   - 填 `Bark 服务地址`
   - 填 `Bark Device Key`
   - 可选填 `Bark 分组`、`Bark 提示音`
5. 如果选的是 `网页通知`
   - 确保当前酒馆地址是 `HTTPS`
   - 点击 `立即订阅`
   - 允许浏览器通知权限

补充说明：

- `通知标题` 对 Bark 和网页通知都生效
- 无论 Bark 还是网页通知，都只发送“已完成 / 已失败”状态提示，不显示回复正文
- 调试日志打开后：
  - 前端会在浏览器控制台输出更详细的流程日志
  - 服务端会输出当前用户的后台任务、Web Push 订阅和发送日志

## 使用方式

启用后，单聊里的普通回复和重新生成流程是：

1. 发送一条普通消息，或点击重新生成
2. 扩展接管这次生成
3. server plugin 在服务端开启后台任务
4. 你可以把浏览器切到后台
5. 生成完成后按设置通过 Bark 或网页通知提醒你
6. 回到酒馆页面后，结果自动同步回聊天

## Docker 提示

如果你的酒馆跑在 Docker 中：

- server plugin 必须安装在 `容器内` 的 `plugins/tavern-notify`
- 前端扩展必须安装在 `容器内` 的 `public/scripts/extensions/third-party/tavern-notify`
- 如果使用 Web Push，对外访问酒馆时必须是 `HTTPS`
- Bark 地址必须是 `容器本身能访问到` 的地址，不要默认写 `localhost`

## 本地检查

运行：

```bash
npm run check
```
