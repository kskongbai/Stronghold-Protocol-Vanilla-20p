# Stronghold Protocol · Vanilla 20p

这是从 `Stronghold-Protocol` 剥离出来的纯插件关闭版本。

保留：
- 20 人联机相关改动
- 对局聊天/交流
- 原版插件工作台（`/studio/`，`.studio-key` 是原版自带，不是插件）
- 原版已有改动

已移除/关闭：
- 所有已安装插件目录（admin-console、fanpack-kazdel-rhodes、makoto、s8-makoto 等）
- 插件专属盟约、装备、干员、策略分类数据
- 插件专属占位立绘
- 管理员后台（没有 admin-console，访问 `/admin/` 返回 404）

启动：
```
set PORT=3001
node server/index.js
```

`plugins/` 里没有已安装插件，但保留原版插件工作台入口，可继续用来导入插件。
