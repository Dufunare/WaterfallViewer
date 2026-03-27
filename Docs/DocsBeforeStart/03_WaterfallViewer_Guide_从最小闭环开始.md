# WaterfallViewer Guide：从最小闭环开始开展项目

> 版本：v0.2  
> 适用对象：当前会 JavaScript、正在学习 Rust、刚开始系统接触 Vue / Tauri 工程开发的实现者。  
> 当前项目基线：**Vue 3 + TypeScript + Vite + Tauri 2 + Rust**  
> 文档目的：告诉你“现在就该怎么开始做”，而不是给你一份泛泛的教程目录。  
> 最后更新：2026-03-27

---

## 0. 这份 Guide 的使用方式

这份 Guide 不是让你“先学完再开始”，而是让你：

1. 明确当前第一目标是什么
2. 知道第一批该建哪些文件
3. 知道每一步先做什么、后做什么
4. 知道哪些东西现在不要碰
5. 知道最小闭环完成后怎么进入下一阶段

你现在最重要的不是“知识面铺满”，而是：

> **把主链做通，并且边界做对。**

---

## 1. 你当前的起点与最合理策略

### 1.1 你的当前情况

- 会 JavaScript
- 正在学习 Rust
- 已切换前端框架为 Vue
- 已建立 Tauri 项目骨架
- 还没有正式进入项目实现阶段

### 1.2 这意味着什么

这意味着你不适合一开始就：

- 深挖大型前端生态
- 搞复杂状态管理
- 搞高级 Rust 抽象
- 同时做图片 / 视频 / 音频 / 缩略图 / 虚拟滚动 / 缓存

你最适合的方式是：

> **先做最小闭环：真实目录 -> Rust 扫描 -> Vue 显示 -> 点击预览。**

### 1.3 你现在真正需要的能力

不是“全学会”，而是先具备这些最低能力：

#### 前端侧

- 会写 Vue 单文件组件
- 会用 `ref` / `computed` / `watch`
- 会用 TypeScript 定义基础类型
- 会把页面拆成组件
- 会在组件里接收 props、发出事件

#### Rust / Tauri 侧

- 能写 struct
- 能写 Result / Option 基本流程
- 能写目录遍历
- 能返回序列化结构
- 能注册 Tauri command
- 能被前端调用并返回真实数据

---

## 2. 当前第一目标：最小闭环（P0）

### 2.1 P0 的用户视角 Definition of Done

用户操作路径：

1. 打开应用
2. 点击“选择文件夹”
3. 选择一个包含若干图片的目录
4. 1~3 秒内出现图片流
5. 页面可以滚动
6. 点击任意图片，可打开预览
7. 关闭预览后仍能继续浏览

### 2.2 P0 的工程视角 Definition of Done

- 不使用假数据
- 必须经过 Tauri IPC
- 必须有独立布局函数
- 前端不自己读取图片尺寸
- Rust 负责扫描和宽高返回
- 必须在真实目录上可演示

### 2.3 为什么 P0 只先做图片

因为图片主链已经覆盖了项目最关键的能力：

- 目录选择
- 文件扫描
- 元数据读取
- 前后端通信
- 布局计算
- 列表显示
- 预览开关

视频 / 音频可以在这条主链稳定后再接。

---

## 3. 你现在不要做的事

这部分非常重要。

### 3.1 现在不要同时推进的内容

- 视频 / 音频完整支持
- 缩略图缓存
- 完整虚拟滚动
- 批次扫描事件流
- 高级过滤器
- 数据库 / 长期索引
- 复杂动画
- 大规模重构式“架构完美主义”

### 3.2 为什么不要现在做

因为这些内容会显著增加：

- 调试面
- 失败面
- 心智负担
- 项目迟迟不闭环的风险

你现在的任务不是“把未来全部问题都提前解决”，而是：

> **先把最值钱的主链做通。**

---

## 4. 推荐的第一批目录与文件

> 下面这份结构是“最小闭环可落地版”，不是最终全量版。

### 4.1 前端目录（Vue）

```text
src/
  presentation/
    pages/
      HomePage.vue
    components/
      folder-picker/
        FolderPickerButton.vue
      media-grid/
        MediaGrid.vue
      media-card/
        MediaCard.vue
      viewer/
        ImageViewer.vue
      feedback/
        EmptyState.vue

  orchestration/
    composables/
      useMediaScan.ts
      useViewer.ts

  layout/
    engines/
      masonryLayout.ts
    types/
      layout.ts

  shared/
    types/
      media.ts
      viewer.ts
      ipc.ts
    tauri/
      commands.ts

  App.vue
  main.ts
```

### 4.2 Rust 目录

```text
src-tauri/src/
  application/
    commands/
      mod.rs
      scan_media.rs
    services/
      mod.rs
      media_scan_service.rs
    models/
      mod.rs
      media_item.rs
    dto/
      mod.rs
      media_item_dto.rs

  infrastructure/
    filesystem/
      mod.rs
      walk.rs
    parser/
      mod.rs
      media_kind.rs
      image_info.rs

  lib.rs
  main.rs
```

### 4.3 这些文件为什么是第一批

因为它们刚好覆盖：

- 页面展示
- 用户动作
- Rust 扫描
- 元数据读取
- IPC
- 布局
- 预览

不多，也不漏主链。

---

## 5. 按工作包推进：你现在该怎么做

下面是我最推荐的推进顺序。  
请尽量**按顺序做**，不要跳着做。

---

## WP0：确认工程骨架能正常启动

### 目标

确认你当前的 Tauri + Vue + TypeScript 工程在本机是健康的。

### 你要完成什么

- `npm install`
- `npm run tauri dev`
- 确认桌面窗口能打开
- 确认 Vue 页面能正常热更新

### 完成标志

- 修改 `App.vue` 能看到页面变化
- 开发窗口没有基础报错
- Rust 端可以参与构建

### 为什么先做这个

因为如果环境没稳，后面所有问题都会混在一起，你根本不知道是代码错了还是环境没通。

---

## WP1：打通最小 IPC，不涉及真实扫描

### 目标

先证明前端和 Rust 真的能说话。

### 你要完成什么

Rust 先写一个最简单命令，例如：

- `hello_from_rust`
- 或 `ping`

前端调用它并在页面上显示结果。

### 前端文件

- `src/shared/tauri/commands.ts`
- `src/presentation/pages/HomePage.vue`

### Rust 文件

- `src-tauri/src/application/commands/scan_media.rs`（可以先放测试命令）
- `src-tauri/src/lib.rs`
- `src-tauri/src/main.rs`

### 完成标志

- 前端能调用 Rust
- 页面能显示 Rust 返回的内容

### 为什么这一小步非常重要

因为它能把“环境问题”和“业务问题”拆开。  
如果这里没通，你就先别写扫描器。

---

## WP2：先打通目录选择

### 目标

先拿到“用户选中的目录路径”。

### 你要完成什么

- 页面上有一个“选择文件夹”按钮
- 点击后能弹出原生目录选择
- 拿到根目录路径
- 把路径显示在页面上或打日志

### 涉及文件

前端：

- `FolderPickerButton.vue`
- `HomePage.vue`
- `useMediaScan.ts`

### 完成标志

- 你能真实选择一个本地目录
- 页面上能拿到并记录这个路径

### 注意

目录选择能力可以由 Tauri 提供的原生能力实现；当前阶段先以“能拿到目录路径”为目标，不必过早把目录选择封装得很复杂。

---

## WP3：Rust 递归扫描图片并返回宽高

### 目标

让 Rust 真正返回**可用的图片列表数据**。

### 你要完成什么

Rust 侧完成以下流程：

1. 接收根目录路径
2. 递归遍历目录
3. 筛出支持的图片
4. 读取宽高
5. 生成 `MediaItem` / DTO
6. 返回给前端

### 涉及文件

Rust：

- `application/commands/scan_media.rs`
- `application/services/media_scan_service.rs`
- `application/models/media_item.rs`
- `application/dto/media_item_dto.rs`
- `infrastructure/filesystem/walk.rs`
- `infrastructure/parser/media_kind.rs`
- `infrastructure/parser/image_info.rs`

### 建议策略

- 第一阶段只识别图片
- 扩展名判断先简单做
- 宽高读取优先用轻量方式，不完整解码整张图
- 错误文件允许跳过，但要留基本日志

### 完成标志

- 前端能拿到真实图片列表
- 每个图片至少带有：
  - path
  - width
  - height
  - kind
  - id

### 这一步是主链真正的核心

只要这一步通了，你的项目就已经不是“空壳桌面应用”，而是真正在碰本地文件系统了。

---

## WP4：独立布局函数

### 目标

把“图片数据 -> 屏幕位置”这件事独立出来。

### 你要完成什么

在前端实现一个最简单的纵向瀑布流函数：

输入：

- 图片列表
- 容器宽度
- 列数
- gap

输出：

- 每个图片卡片的 `x / y / width / height`

### 涉及文件

- `src/layout/engines/masonryLayout.ts`
- `src/layout/types/layout.ts`

### 完成标志

- 不依赖 Vue 组件也能单独调用布局函数
- 给一组图片尺寸能输出稳定坐标结果

### 为什么这一步不能偷懒

因为你已经明确把“独立布局函数”作为架构要求的一部分。  
第一版简单可以，但不能不存在。

---

## WP5：把图片流显示出来

### 目标

把 Rust 返回的数据真正变成页面上的图片流。

### 你要完成什么

前端完成：

- 拿到 `MediaItem[]`
- 调布局函数得到 `LayoutItem[]`
- 渲染图片列表
- 页面能滚动

### 涉及文件

- `HomePage.vue`
- `MediaGrid.vue`
- `MediaCard.vue`
- `useMediaScan.ts`
- `media.ts`

### 当前建议

- 第一版可以先只做基础滚动区
- 不必在这一阶段就做完整虚拟滚动
- 但 DOM 不要无脑写死在单文件中

### 完成标志

- 选目录后能看到真实图片流
- 页面可以连续滚动
- 占位逻辑基本稳定，不严重跳动

---

## WP6：实现预览层

### 目标

把“点击看大图”这条链补齐。

### 你要完成什么

- 点击卡片
- 打开预览层
- 显示当前图片
- 点击关闭
- 回到原列表继续浏览

### 涉及文件

- `ImageViewer.vue`
- `useViewer.ts`
- `MediaCard.vue`
- `HomePage.vue`

### 完成标志

- 点击任意图片可以预览
- 关闭后列表仍在
- 没有因为预览开关导致页面状态丢失

---

## 6. 每个文件先做什么

这部分很实用。  
不是“所有文件都要写满”，而是告诉你第一版每个文件的最低职责。

### 6.1 前端

#### `HomePage.vue`

- 第一屏页面
- 组织按钮、图片流、预览层
- 尽量不放重逻辑

#### `FolderPickerButton.vue`

- 只负责触发目录选择
- 不负责扫描目录业务本身

#### `MediaGrid.vue`

- 只负责渲染布局结果
- 接收列表数据和点击事件

#### `MediaCard.vue`

- 单个图片卡片
- 只负责显示与点击

#### `ImageViewer.vue`

- 预览层 UI
- 只负责显示当前选中图片与关闭动作

#### `useMediaScan.ts`

- 管理扫描流程
- 持有 `items / loading / error`
- 调用 Rust command

#### `useViewer.ts`

- 管理 `isOpen / selectedItem`

#### `masonryLayout.ts`

- 纯函数
- 不依赖 Vue
- 先实现最简单纵向布局

#### `commands.ts`

- 集中封装前端对 Rust 的调用
- 不要让 `invoke(...)` 到处散落

#### `media.ts`

- 定义 `MediaItem`

### 6.2 Rust

#### `scan_media.rs`

- 暴露 Tauri command
- 参数检查
- 调 service
- 返回结果

#### `media_scan_service.rs`

- 组织扫描业务
- 不直接写平台细节

#### `walk.rs`

- 递归遍历目录

#### `media_kind.rs`

- 判断当前文件是不是支持的图片

#### `image_info.rs`

- 读取宽高

#### `media_item.rs`

- Rust 内部媒体结构

#### `media_item_dto.rs`

- 序列化给前端的返回结构

#### `lib.rs`

- 模块汇总
- 命令注册
- Tauri app 组装

#### `main.rs`

- 程序入口

---

## 7. 你当前需要补的知识，不要超纲学

### 7.1 Vue 只先学到这些

- 单文件组件
- `ref`
- `computed`
- `watch`
- `v-for`
- `v-if`
- props / emits
- 基本 composables

### 7.2 TypeScript 只先学到这些

- `type` / `interface`
- 联合类型
- 可选字段
- 函数类型
- 先别沉迷高级泛型

### 7.3 Rust 只先学到这些

- `struct`
- `enum`
- `Result`
- `Option`
- 基本模块拆分
- 路径遍历
- 序列化

### 7.4 现在先别深挖的

- 高级生命周期技巧
- 大型状态管理框架设计
- 复杂前端动画体系
- 多线程优化细节
- 视频 / 音频处理全家桶

---

## 8. 现在就可以执行的日常节奏

### 推荐节奏：一天一个小闭环

#### Day 1

- 工程启动
- 改 `App.vue`
- 确认热更新
- 建立目录骨架

#### Day 2

- 打通最小 IPC
- 页面显示 Rust 返回字符串

#### Day 3

- 目录选择
- 页面拿到真实路径

#### Day 4~5

- Rust 扫描图片
- 返回路径和宽高

#### Day 6

- 独立布局函数
- 打印布局结果

#### Day 7

- 图片流渲染

#### Day 8

- 预览层开关

这只是建议节奏，不是硬日历。  
重点是：**每一天都要能看到项目离“可演示”更近一点。**

---

## 9. 调试顺序：出问题先查哪里

### 9.1 页面没反应

先查：

- `App.vue`
- `main.ts`
- 浏览器 / WebView console

### 9.2 前端调不到 Rust

先查：

- `commands.ts`
- Rust command 是否注册
- `lib.rs`
- Tauri 控制台报错

### 9.3 路径选到了但没图片

先查：

- 目录遍历逻辑
- 图片类型判断
- 是否真的返回了列表

### 9.4 图片有数据但页面不显示

先查：

- `MediaGrid.vue`
- 布局函数输出
- 图片资源显示链路

### 9.5 页面跳动严重

先查：

- 是否使用 Rust 返回的宽高
- 占位尺寸是否稳定
- 是否还在前端读尺寸

---

## 10. 当前最容易踩的坑

### 坑 1：为了快，前端直接 `new Image()` 批量读尺寸

不要这样做。  
这会破坏你最重要的边界。

### 坑 2：布局算法直接写进组件

后面一改布局模式会非常痛苦。

### 坑 3：还没打通 IPC，就先做很多 UI

你会很快陷入“页面像是有了，但主链其实没通”的假进展。

### 坑 4：一开始就想把所有目录结构都实现完整

你需要的是“主干先搭正”，不是“每个空目录都写 3 个文件”。

### 坑 5：同时推进视频、音频、缓存和虚拟滚动

对当前阶段来说，这几乎必炸。

---

## 11. P0 完成后怎么进入下一步

### P0 结束标志

当你能现场演示：

- 选择真实图片目录
- Rust 返回真实宽高
- 页面出现图片流
- 可滚动
- 可预览
- 可关闭返回

就算 P0 成功。

### P1 第一优先改进

P0 之后，优先做这些：

1. 整理组件与 composables 边界
2. 错误处理
3. 空状态与无结果状态
4. 滚动位置保持
5. 基础过滤 / 排序
6. 为批次扫描与虚拟滚动预留接口

### 不建议 P0 一结束就立刻做的

- 缩略图缓存
- 视频 / 音频全量接入
- 太重的重构
- 复杂产品化细节

---

## 12. 现在开始前的最后检查清单

在你真正进入编码前，确认下面这些点：

- [ ] 我能本机运行 `npm run tauri dev`
- [ ] 我接受“P0 只做图片主链”
- [ ] 我不会在前端自己读图片尺寸
- [ ] 我会把布局函数独立出来
- [ ] 我会先打通最小 IPC，再写扫描器
- [ ] 我会先做主链，不会同时做十个中后期功能
- [ ] 我理解五层结构是“职责地图”，不是装饰

---

## 13. Guide 的最后一句话

你现在最应该追求的，不是“写得像一个成熟团队的最终产物”，而是：

> **按正确顺序，把最关键的链路做通，并且不破坏未来扩展的边界。**

只要你把这件事做好，WaterfallViewer 就会非常适合作为你从“会写程序”走向“能做完整软件”的第一块真正作品。
