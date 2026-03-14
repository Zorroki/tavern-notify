# 酒馆后台通知

这是一个给手机使用场景准备的 SillyTavern 后台生成方案：

- `server plugin` 负责在服务端创建后台任务，即使手机浏览器切到后台也继续生成
- `third-party extension` 负责在前端拦截兼容的生成请求，把任务转交给 server plugin
- 生成完成后通过 Bark 发送通知
- 你重新回到酒馆页面时，结果会自动同步回当前聊天

## 为什么必须分成两部分

SillyTavern 的 server plugin 只能新增 `/api/plugins/<plugin-id>` 路由，不能直接改写默认生成接口。
而 SillyTavern 原生生成接口会在客户端连接断开时中止生成。

所以要实现“切后台不中断”，必须同时使用两部分：

1. [server/index.mjs](/Users/zorroki/VsCodeProjects/tavern-notify/server/index.mjs)
   负责真正的后台任务和 Bark 推送
2. [index.js](/Users/zorroki/VsCodeProjects/tavern-notify/index.js)、[manifest.json](/Users/zorroki/VsCodeProjects/tavern-notify/manifest.json)、[settings.html](/Users/zorroki/VsCodeProjects/tavern-notify/settings.html)
   在原生生成请求发出前接管流程，避免请求和前台页面生命周期绑定

## 当前已支持

- 普通 `单角色` 回复
- 单角色聊天中的 `重新生成`
- 手机上把浏览器切到后台后继续生成
- 生成完成后推送 Bark 状态通知
- 返回酒馆页面后自动把结果同步回聊天

## 当前限制

- 目前只接管 `normal` 和 `regenerate` 的单聊流程
- `群聊`、`重抽`、`继续生成`、`扮演` 仍走 SillyTavern 默认逻辑
- 后台任务当前保存在 SillyTavern 进程内存里，容器或服务重启后未完成任务会丢失

## 是否支持 Docker

支持。

因为这个方案里的 server plugin 是直接运行在 SillyTavern 的 Node 进程里的，所以只要你的 Docker 容器里运行的是完整的 SillyTavern 服务，并且你能把插件和扩展文件放进容器对应目录，就可以用。

但 Docker 环境下要注意两个关键点：

1. server plugin 必须安装在 `容器内` 的 SillyTavern `plugins` 目录
2. 前端扩展必须安装在 `容器内` 的 `public/scripts/extensions/third-party/tavern-notify` 目录

还要特别注意 Bark 地址：

- 如果用官方 Bark 服务 `https://api.day.app`，通常没问题
- 如果你填的是自建 Bark 服务或局域网 Bark 地址，这个地址必须是 `容器本身能访问到` 的地址
- 不要默认写 `localhost` 或 `127.0.0.1`

原因是：

- 对浏览器来说，`localhost` 是你当前设备
- 对 Docker 容器来说，`localhost` 是容器自己

所以如果 Bark 不在同一个容器里，`localhost` 往往是错的。

## 安装

### 1. 安装 server plugin

把这个仓库克隆到 SillyTavern 的 `plugins` 目录下，例如：

```text
SillyTavern/plugins/tavern-notify
```

并确保 `config.yaml` 已启用 server plugin：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: true
```

server plugin 入口文件是 [server/index.mjs](/Users/zorroki/VsCodeProjects/tavern-notify/server/index.mjs)。

推荐直接在 `plugins` 目录执行：

```bash
git clone <这个仓库的 Git 地址> tavern-notify
```

这样以后 SillyTavern 重启时就能自动更新这个 server plugin。

### 2. 安装前端扩展

这个仓库的根目录现在已经是标准的第三方扩展结构，包含：

- [manifest.json](/Users/zorroki/VsCodeProjects/tavern-notify/manifest.json)
- [index.js](/Users/zorroki/VsCodeProjects/tavern-notify/index.js)
- [settings.html](/Users/zorroki/VsCodeProjects/tavern-notify/settings.html)
- [style.css](/Users/zorroki/VsCodeProjects/tavern-notify/style.css)

所以可以直接在 SillyTavern 页面里用“安装扩展”导入这个仓库地址，不需要再手动复制前端文件。

如果你仍然想手工放文件，目标目录仍然是：

```text
SillyTavern/public/scripts/extensions/third-party/tavern-notify
```

最终至少应包含：

```text
SillyTavern/public/scripts/extensions/third-party/tavern-notify/manifest.json
SillyTavern/public/scripts/extensions/third-party/tavern-notify/index.js
SillyTavern/public/scripts/extensions/third-party/tavern-notify/settings.html
```

### 3. Docker 部署提示

如果你的酒馆跑在 Docker 中，推荐把 `plugins/tavern-notify` 保存在容器挂载卷里。

前端扩展如果使用酒馆内置“安装扩展”，它会自己落到扩展目录，不需要你再额外挂载单独文件。

如果你不使用酒馆内置安装器，也可以继续把前端扩展目录作为 volume 挂载进去，或者直接复制进容器对应路径。

你需要确保容器内最终存在：

```text
/path/to/SillyTavern/plugins/tavern-notify
/path/to/SillyTavern/public/scripts/extensions/third-party/tavern-notify
```

### 4. 重启 SillyTavern

重启酒馆服务或 Docker 容器，让 plugin 和 extension 一起加载。

## 配置

打开扩展设置中的 `酒馆后台通知`，填写：

- `启用单聊后台接管`
- `Bark 服务地址`
  一般填 `https://api.day.app`
- `Bark Device Key`
- 可选填写 `Bark 分组`、`Bark 提示音`、`通知标题`

说明：

- Bark 现在只发送“已完成 / 已失败”这类状态提示，不会把回复正文直接显示在通知里
- `通知标题` 可以自定义，默认是 `酒馆后台通知`

你可以先点：

- `检测插件`
  确认 server plugin 已被正确加载
- `发送 Bark 测试通知`
  确认 Bark 可达

## 推荐更新方式

推荐把这个仓库当成“同一个仓库，两处安装”来用：

1. 前端扩展：在酒馆页面里通过仓库地址直接安装
2. server plugin：把同一个仓库克隆到 `plugins/tavern-notify`

这样后续更新时：

- 前端扩展可以直接在酒馆的扩展管理页面更新
- server plugin 可以依赖 `enableServerPluginsAutoUpdate: true` 在重启时自动拉取

## 使用方式

启用后，单聊里的普通回复和重新生成流程是：

1. 发送一条普通消息，或点击一次重新生成
2. 扩展先接管这次生成
3. server plugin 在服务端开启后台任务
4. 你可以把手机浏览器切到后台
5. 生成完成后 Bark 通知你
6. 回到酒馆页面后，结果自动同步回聊天

## 本地检查

运行：

```bash
npm run check
```
