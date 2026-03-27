# WaterfallViewer 架构文档

> 版本：v0.2  
> 当前技术基线：**Vue 3 + TypeScript + Vite + Tauri 2 + Rust**  
> 当前架构主视图：**五层模型**  
> 文档目的：明确职责边界、目录结构、关键模型、运行主流程与后续改动入口。  
> 最后更新：2026-03-27

---

## 0. 文档说明

这份文档不是“把所有实现细节都一次性写死”的说明书，而是用于回答下面这些问题：

- 这个项目为什么要按五层结构组织？
- 每一层到底负责什么？
- 哪一层能依赖哪一层？
- 以后想加功能时，第一眼应该改哪里？
- 在项目未启动或刚启动时，如何避免结构早早失控？

本架构文档遵循一个核心前提：

> **前端只负责渲染、交互与视图编排；Rust/Tauri 负责目录扫描、元数据提取、系统能力与重计算。**

---

## 1. 架构目标

WaterfallViewer 的架构设计目标，不是“形式上分很多层”，而是解决真实工程问题：

1. **避免前端承担不该承担的重活**
   - 比如批量测图片尺寸、扫描目录、解析媒体头部。

2. **避免业务逻辑直接散落到 UI 组件**
   - 否则后续改动会非常痛苦。

3. **保证布局层可独立测试与复用**
   - 后面做横向布局、导出长图、虚拟滚动时都会受益。

4. **让第一闭环和后续扩展能沿同一条主干演进**
   - 不因为第一版写得太“临时”，导致第二版几乎重写。

5. **让“改什么去哪里改”这件事足够直观**
   - 这是你当前阶段最需要的工程能力之一。

---

## 2. 总体分层模型

```text
表现层（UI / Components）
        ↓
交互编排层（Composables / Store / Page Controller）
        ↓
布局与视图模型层（Layout Engine / Virtual Window）
        ↓
领域与应用服务层（Rust Services / Tauri Commands）
        ↓
基础设施与平台层（File System / OS / Crates / Tauri Capability）
```

这是你的项目当前最推荐的“主架构视图”。

### 为什么采用五层模型

因为它比“按技术类型堆目录”更容易回答下面这些问题：

- 这个功能到底属于 UI、状态、布局还是后端？
- 这次需求改动是不是会破坏边界？
- 我以后扩展视频 / 音频时，应该先动哪一层？
- 如果要引入缩略图缓存，应该落在哪层，而不污染其他层？

---

## 3. 依赖方向与基本纪律

### 3.1 总原则

> **上层使用下层，下层不要知道上层。**

也就是：

- UI 可以调用编排层
- 编排层可以调用布局层和应用服务层
- 应用服务层可以调用基础设施层

但反过来不应该成立。

### 3.2 正确的依赖关系

```text
表现层
  ↓
交互编排层
  ↓
布局层        应用服务层
                ↓
             基础设施层
```

更具体一点：

- 表现层依赖交互编排层
- 交互编排层依赖布局层与 Rust 对外能力
- 布局层尽量保持独立
- Rust 应用服务层依赖基础设施层
- 基础设施层不反向依赖任何上层

### 3.3 绝对要避免的事

- 基础设施层知道 Vue 组件长什么样
- Rust 服务返回“某个页面专属格式”
- 布局算法直接写死在组件里
- 前端自己去批量读图片尺寸
- 为了省事把所有逻辑塞进 `App.vue` 和 `main.rs`

---

## 4. 推荐目录结构（五层映射版）

> 这是一份推荐结构。不是所有目录都要在第一天写满，但应尽量沿这个方向组织。

```text
waterfallviewer/
├─ src/
│  ├─ presentation/                         # 第1层：表现层
│  │  ├─ app/
│  │  ├─ pages/
│  │  ├─ components/
│  │  │  ├─ folder-picker/
│  │  │  ├─ media-grid/
│  │  │  ├─ media-card/
│  │  │  ├─ viewer/
│  │  │  ├─ feedback/
│  │  │  └─ filters/
│  │  └─ styles/
│  │
│  ├─ orchestration/                        # 第2层：交互编排层
│  │  ├─ composables/
│  │  ├─ stores/
│  │  ├─ controllers/
│  │  └─ view-models/
│  │
│  ├─ layout/                               # 第3层：布局与视图模型层
│  │  ├─ engines/
│  │  ├─ virtual-window/
│  │  ├─ projections/
│  │  └─ types/
│  │
│  ├─ shared/                               # 共享类型与工具
│  │  ├─ types/
│  │  ├─ utils/
│  │  ├─ constants/
│  │  └─ tauri/
│  │
│  ├─ assets/
│  ├─ App.vue
│  └─ main.ts
│
├─ src-tauri/
│  ├─ src/
│  │  ├─ application/                      # 第4层：领域与应用服务层
│  │  │  ├─ commands/
│  │  │  ├─ services/
│  │  │  ├─ models/
│  │  │  └─ dto/
│  │  │
│  │  ├─ infrastructure/                   # 第5层：基础设施与平台层
│  │  │  ├─ filesystem/
│  │  │  ├─ parser/
│  │  │  ├─ platform/
│  │  │  ├─ thumbnail/
│  │  │  ├─ cache/
│  │  │  └─ task_manager/
│  │  │
│  │  ├─ lib.rs
│  │  └─ main.rs
│  │
│  ├─ capabilities/
│  ├─ icons/
│  ├─ Cargo.toml
│  └─ tauri.conf.json
```

### 为什么不用“components / composables / services”横向堆满整个项目根部

因为那样虽然整齐，但不利于你建立“职责感”。  
五层结构更适合你现在这个阶段，因为它会强迫你每次写代码前先回答：

- 这段逻辑是在“画页面”？
- 还是在“调度状态”？
- 还是在“算布局”？
- 还是在“做业务”？
- 还是在“碰系统”？

---

## 5. 第 1 层：表现层（Presentation / UI Layer）

### 5.1 这一层的职责

表现层负责：

- 渲染页面与组件
- 接收点击、滚动、键盘操作
- 展示空状态、加载状态、错误状态
- 根据上层给出的状态渲染媒体卡片、预览层与控制条

典型文件：

- `HomePage.vue`
- `FolderPickerButton.vue`
- `MediaGrid.vue`
- `MediaCard.vue`
- `ImageViewer.vue`
- `EmptyState.vue`

### 5.2 这一层应该做什么

- 把 `MediaItem` 与 `LayoutItem` 渲染出来
- 发出 `onPickFolder`、`onOpenItem`、`onCloseViewer` 之类的用户动作
- 显示“还没选目录”“扫描失败”“无结果”这类界面反馈

### 5.3 这一层不应该做什么

- 不扫描目录
- 不直接调用文件系统
- 不自己批量测图片尺寸
- 不持有重型业务状态机
- 不把布局核心计算写死在组件里

### 5.4 典型改动入口

如果你以后要改这些内容，优先看表现层：

- 按钮样式
- 卡片样式
- 预览层外观
- 空状态与错误提示
- 过滤器 UI

---

## 6. 第 2 层：交互编排层（Orchestration Layer）

> 在 Vue 项目里，这一层通常由 **composables + 少量 store + 页面级 controller** 组成。

### 6.1 这一层的职责

它负责把：

- 用户动作
- Rust 返回的数据
- 布局引擎输出

组织成 **UI 可以直接消费的状态**。

典型文件：

- `useMediaScan.ts`
- `useViewer.ts`
- `useMediaFilter.ts`
- `mediaPageController.ts`
- `mediaStore.ts`

### 6.2 这一层应该做什么

- 发起扫描
- 接收扫描结果
- 管理 `items / loading / error / selectedItem`
- 根据过滤器和排序规则生成当前视图数据
- 调用布局函数
- 管理滚动位置恢复
- 未来处理批次扫描事件与取消扫描

### 6.3 这一层不应该做什么

- 不直接做文件系统 I/O
- 不直接解析媒体头部
- 不把大量计算写进组件
- 不让全局 store 无限膨胀

### 6.4 为什么 Vue 用 composables 非常合适

因为你的项目当前并不需要一上来就引入很重的状态管理体系。  
很多页面逻辑，其实先用 composables 就能很好承接：

- `useMediaScan`：扫描状态
- `useViewer`：预览层状态
- `useFilter`：过滤条件
- `useScrollRestore`：滚动位置恢复

先这样做，复杂度更可控。

---

## 7. 第 3 层：布局与视图模型层（Layout Layer）

### 7.1 这一层的职责

布局层负责把媒体数据变成“屏幕上的摆放结果”。

输入通常是：

- 媒体项列表
- 容器宽度
- 列数
- gap
- 布局模式

输出通常是：

- 每个卡片的 `x / y / width / height`
- 总滚动高度
- 当前可视范围（后续）

典型文件：

- `masonryLayout.ts`
- `visibleRange.ts`
- `mediaProjection.ts`
- `layout.ts`

### 7.2 这一层应该做什么

- 纵向瀑布流布局计算
- 后续横向 justified 布局计算
- 骨架占位尺寸生成
- 虚拟窗口计算
- overscan 范围计算

### 7.3 这一层不应该做什么

- 不依赖 Vue DOM 查询结果作为主输入
- 不直接调 Tauri 命令
- 不读文件系统
- 不关心点击事件是从按钮还是键盘来的

### 7.4 为什么布局层必须独立

因为这层是你项目最独特、最容易被污染的部分。  
如果你把布局算法直接写在组件里，后面会很难做：

- 横向布局
- 虚拟滚动
- 导出长图
- 预计算占位
- 测试与调参

所以第一闭环时哪怕布局很简单，也必须把它拆成独立函数。

---

## 8. 第 4 层：领域与应用服务层（Rust Application Layer）

### 8.1 这一层的职责

这层是 Rust 侧真正的“业务入口层”。

它负责：

- 暴露 Tauri commands
- 组织“扫描目录”“读取元数据”“生成缩略图”这类业务动作
- 统一对外返回的数据结构

典型文件：

- `commands/scan_media.rs`
- `services/media_scan_service.rs`
- `models/media_item.rs`
- `dto/media_item_dto.rs`

### 8.2 这一层应该做什么

- 接收前端的业务请求
- 调用底层服务
- 组织返回给前端的结构
- 屏蔽底层 crate 差异
- 稳定前后端通信契约

### 8.3 这一层不应该做什么

- 不使用页面语义命名命令
  - 错误示例：`scan_directory_for_three_column_dark_mode`
- 不关心 Vue 页面结构
- 不直接嵌入 UI 用语
- 不把平台细节一股脑暴露给前端

### 8.4 推荐的 Rust 命令设计原则

前端与 Rust 的接口应该围绕“业务动作”，而不是围绕“组件行为”。

推荐这种感觉的命名：

- `scan_images`
- `scan_media`
- `cancel_scan`
- `request_thumbnail`
- `open_in_system`

而不是：

- `grid_card_click`
- `viewer_load_next_page`

---

## 9. 第 5 层：基础设施与平台层（Infrastructure Layer）

### 9.1 这一层的职责

这里是项目真正“碰系统”的地方。

它负责：

- 遍历目录
- 打开文件
- 读取字节
- 判断媒体类型
- 解析图片 / 视频 / 音频信息
- 管理缓存目录
- 管理任务队列
- 管理与平台相关的能力

典型文件：

- `filesystem/walk.rs`
- `parser/image_info.rs`
- `parser/media_kind.rs`
- `platform/dialogs.rs`
- `thumbnail/...`
- `cache/...`
- `task_manager/...`

### 9.2 这一层应该做什么

- 真正调用 `read_dir` / `open` / `read`
- 真正接第三方 crate
- 真正做平台差异处理
- 真正控制路径、权限与能力边界

### 9.3 这一层不应该做什么

- 不决定扫描流程什么时候开始
- 不决定 UI 当前是不是在预览态
- 不知道瀑布流有几列
- 不返回“专门给某个组件看”的结果

---

## 10. 关键数据模型

项目越早统一数据模型，后面返工越少。  
以下是当前推荐的基线结构。

### 10.1 前端 TypeScript 基线

```ts
export type MediaKind = "image" | "video" | "audio";

export type MediaItem = {
  id: string;
  path: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  aspectRatio?: number;
  durationMs?: number;
  createdAt?: number;
  modifiedAt?: number;
  thumbPath?: string;
  displaySrc?: string;
  scanSessionId: string;
};

export type LayoutOptions = {
  mode: "masonry-vertical" | "justified-horizontal";
  columnCount?: number;
  rowHeight?: number;
  gap: number;
  viewportWidth: number;
};

export type LayoutItem = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
```

### 10.2 字段设计原则

#### `id`

不要长期把 `path` 写死成唯一主键。  
未来你可能需要：

- 视图层标识
- 缓存键
- 会话隔离
- 变更跟踪

#### `path`

保留原始路径，但前端直接展示时应通过受控链路处理。

#### `width / height / aspectRatio`

这是布局层最关键的数据。  
**由 Rust 提供，前端只消费。**

#### `scanSessionId`

用于隔离当前目录会话。  
未来做取消扫描或重入时非常有用。

---

## 11. IPC 契约设计

IPC 是前端与 Rust 的边界，必须尽量稳定。

### 11.1 第一闭环建议接口

#### 目录选择

目录选择可以通过原生目录选择能力完成，最终得到根目录路径。  
目录选择能力本身可以由前端调用 Tauri 提供的能力，也可以由 Rust 侧进一步封装；当前阶段不强制锁死实现方式。

#### 扫描接口

第一闭环推荐最简单的命令形态：

```text
scan_images(rootPath) -> MediaItem[]
```

返回内容至少包含：

- 路径
- 图片类型
- 宽度
- 高度
- 基础 id

### 11.2 第二阶段可升级接口

```text
scan_media(rootPath, options) -> taskId
scan_progress(taskId) -> event
scan_batch(taskId) -> event
cancel_scan(taskId)
request_thumbnail(itemId)
```

### 11.3 契约设计原则

- 先允许小目录“一次返回”
- 但命名和结构上要为“批次返回”留升级空间
- 不要把 UI 事件直接映射成 IPC 接口
- 错误返回应结构化，而不是只返回字符串

---

## 12. 运行时主流程

### 12.1 目录选择 -> 图片流渲染

1. 用户点击“选择文件夹”
2. 表现层发出动作
3. 编排层拿到路径后调用 Rust 扫描接口
4. Rust 应用服务层启动扫描
5. 基础设施层递归遍历目录并读取图片尺寸
6. Rust 返回 `MediaItem[]`
7. 编排层调用布局引擎得到 `LayoutItem[]`
8. 表现层渲染图片流
9. 用户开始滚动浏览

### 12.2 点击预览 -> 关闭返回

1. 用户点击某张图片
2. 表现层发出 `open(itemId)`
3. 编排层更新 viewer 状态
4. 表现层渲染 `ImageViewer`
5. 用户关闭预览
6. 编排层恢复 viewer 状态，并尽量保持浏览上下文

### 12.3 后续懒加载 / 缩略图链

1. 列表先渲染占位
2. 元素接近视口时触发资源加载
3. 如果缩略图存在则直接用
4. 如果不存在则进入后台任务队列
5. 加载完成后替换为低成本可展示资源

---

## 13. 横切关注点

### 13.1 性能

- 虚拟滚动是架构要求，不是纯优化项
- 宽高信息必须提前可用，否则布局不稳定
- 大量重型任务要后端接住，不要落在前端主线程

### 13.2 错误处理

- 目录为空
- 没权限
- 文件损坏
- 某些元数据读取失败

都不应该直接把页面打崩。  
Rust 返回结构化错误，前端负责局部提示与降级。

### 13.3 安全

- 只访问用户主动选择的目录
- 不默认放开任意路径
- 用 Tauri capability / permission / scope 思想控制边界

### 13.4 日志与排错

建议从一开始就区分：

- 前端动作日志
- Rust 扫描日志
- 错误与降级日志

这样排查问题时更快知道是：

- 目录没扫出来
- 数据没过来
- 布局算错了
- UI 没渲染

### 13.5 测试

- 布局层适合做纯函数测试
- Rust 扫描 / 解析服务适合做单元测试和样例目录测试
- UI 层前期可先以人工演示验收为主

---

## 14. 需求改动时的优先修改入口

| 需求变化           | 优先改哪里                | 可能联动                         |
| ------------------ | ------------------------- | -------------------------------- |
| 新增排序规则       | 编排层                    | 可能补充 `createdAt` 等字段      |
| 新增媒体类型       | Rust parser / models      | 过滤器、预览层、卡片占位         |
| 切换横向布局       | layout 层                 | UI 容器样式与设置面板少量联动    |
| 引入缩略图缓存     | Rust thumbnail / cache    | 前端只多消费 `thumbPath`         |
| 增加扫描进度条     | IPC + 编排层              | UI 只是多渲染一个状态            |
| 增加导出长图 / PDF | layout + 独立导出服务     | 复用 `MediaItem` 与 `LayoutItem` |
| 增加系统右键能力   | infrastructure / platform | capability、命令层小幅联动       |

---

## 15. 当前未锁死、但已经有方向的设计点

### 15.1 前端状态管理方案

当前建议：

- 先以 composables 为主
- 必要时引入轻量 store
- 不在第一天就重度依赖大型状态框架

### 15.2 虚拟滚动实现方式

当前建议：

- 第一闭环先不强行做完整形态
- 但布局和可视范围接口要预留位置
- 等图片主链稳定后再强化

### 15.3 视频 / 音频元数据

当前建议：

- 图片主链稳定后单独接入
- 不与第一闭环绑死

### 15.4 缩略图缓存

当前建议：

- 第二阶段再落地
- 当前先保留目录与接口壳即可

---

## 16. 架构文档最后的判断标准

如果未来某次改动让你开始出现这些现象，说明架构正在变坏：

- 前端组件越来越像“后端服务”
- 布局算法散落在多个组件里
- Rust 命令名越来越像页面按钮名
- 新增一个功能要同时改 8 个不相干文件
- 为了图省事把路径、类型、尺寸判断都塞回前端

反过来，如果你始终能做到：

- 改 UI 去表现层
- 改流程去编排层
- 改坐标去布局层
- 改扫描去 Rust 应用服务层
- 改底层库去基础设施层

那这份架构就是健康的。
