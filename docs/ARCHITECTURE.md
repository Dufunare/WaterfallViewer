# WaterfallViewer 核心技术与架构设计

> 版本：v0.3
> 状态：Architecture Baseline
> 技术基线：Vue 3 + TypeScript + Vite + Tauri 2 + Rust
> 面向平台：Desktop First，Mobile Ready
> 核心目标：高性能本地媒体浏览、普通瀑布流 + 自由画布、多媒体扩展、视觉与功能解耦
> 更新时间：2026-09

---

# 0. 文档定位

本文档在原 `PROJECT.md v0.2` 与 `ARCHITECTURE.md v0.2` 基础上重新确定 WaterfallViewer 的核心技术与软件架构。

原设计中以下方向继续保留：

* 本地优先；
* 用户选择目录后进行会话式浏览；
* 递归访问目录并提取媒体；
* 前端负责交互和呈现；
* Rust 负责文件系统、媒体元数据和高成本任务；
* 布局逻辑不得直接散落在 UI 组件中；
* 性能和资源占用是核心非功能需求。

本版本重点修订四件事：

1. **不再以“尽量少做、尽量少用资源”为首要约束。**
2. **自由视角 / 无限画布从未来功能提升为核心视图模式。**
3. **性能流水线、缓存、任务调度从优化项提升为基础架构。**
4. **功能、交互、布局、渲染、视觉主题进一步拆开。**

---

# 1. 项目核心定义

WaterfallViewer 是一个：

> 面向本地媒体资源的、高性能、会话式、多视图媒体浏览器。

它的核心不是“管理文件”，而是：

> 把散落在目录树中的媒体资源转换成一个可以连续、高效、自由浏览的视觉空间。

长期至少存在三种核心使用方式：

```text
Folder Tree / Source
        │
        ▼
Media Session
        │
        ├── Traditional Flow
        │     ├── Vertical Masonry
        │     └── Horizontal / Justified
        │
        ├── Free Canvas
        │     └── Pan / Zoom / Spatial Browsing
        │
        └── Viewer
              ├── Image
              ├── Animated Image
              ├── Video
              └── Audio
```

普通瀑布流解决：

> 快速、线性、连续地浏览大量媒体。

自由画布解决：

> 不被页面上下方向束缚，在二维空间中缩放、平移和浏览大量媒体。

Viewer 则解决：

> 对某一个媒体对象进行高质量查看或播放。

---

# 2. 架构设计原则

## 2.1 功能与视觉分离

这是本项目最重要的架构要求之一。

视觉层不得拥有：

* 文件扫描逻辑；
* 媒体识别逻辑；
* 排序和过滤的业务规则；
* 缓存策略；
* 媒体任务调度；
* 瀑布流核心算法；
* 自由画布空间模型。

因此：

```text
功能状态
    ↓
View Model
    ↓
Layout / Scene Model
    ↓
Renderer
    ↓
Theme / Visual Skin
```

改变：

* 配色；
* 圆角；
* 阴影；
* 字体；
* 动画；
* 控件形态；
* 卡片视觉；
* 背景效果；

原则上不应该改变上面四层。

原纯前端版本把背景惯性、鼠标涟漪等视觉效果直接写在 HTML/页面脚本中，这种实现适合作为原型，但正式版本中应进入独立的 Visual Effect / Theme 层。

---

## 2.2 核心能力不依赖 Tauri

Rust 的核心媒体能力应能够：

```text
cargo test
```

独立运行。

也就是说：

> Tauri 是 WaterfallViewer 的应用壳与 IPC Adapter，而不是业务核心。

目录扫描、元数据、缩略图、查询、缓存等能力不能直接写死在 `#[tauri::command]` 中。

这样未来才能比较自然地：

* 移植到 Android；
* 移植到 iOS；
* 编写 CLI；
* 做测试工具；
* 做 benchmark；
* 替换 GUI 技术。

Tauri 2 已正式支持 Android/iOS，移动端插件也允许分别通过 Kotlin 和 Swift 接入平台原生能力，因此将平台差异隔离在 Adapter 层是有现实意义的。

---

## 2.3 数据模型不依赖具体视图

同一个 `MediaItem` 可以出现在：

* 三列瀑布流；
* 七列瀑布流；
* 横向流；
* 搜索结果；
* 无限画布；
* Viewer；
* 文件夹导航。

因此：

```text
MediaItem ≠ MediaCard
MediaItem ≠ MasonryItem
MediaItem ≠ CanvasSprite
```

媒体本身、布局结果、最终渲染对象必须分离。

---

## 2.4 大数据默认流式处理

正式架构不采用：

```text
扫描整个目录
↓
全部完成
↓
返回 MediaItem[]
↓
开始显示
```

而采用：

```text
启动 Session
    ↓
扫描
    ↓
Metadata Batch
    ↓
Frontend Index
    ↓
Incremental Layout
    ↓
Visible Items
```

Tauri 2 的 Channel 本身就是面向快速、有序数据流设计的，官方也建议高吞吐流式数据优先使用 Channel 而不是普通全局 Event。

---

# 3. 核心技术选型

| 领域       | 推荐技术                          | 职责                      |
| -------- | ----------------------------- | ----------------------- |
| 桌面/移动应用壳 | Tauri 2                       | Window、IPC、权限、平台插件      |
| 后端核心     | Rust                          | 扫描、元数据、缩略图、缓存、任务调度      |
| 异步 I/O   | Tokio                         | 文件及异步任务编排               |
| CPU 密集任务 | 有界 Worker / Rayon 类线程池        | 解码、缩放、图像分析              |
| 前端框架     | Vue 3                         | UI 与组件生命周期              |
| 前端语言     | TypeScript                    | View Model、布局、交互        |
| 构建       | Vite                          | 前端开发与构建                 |
| 普通媒体流    | DOM + Virtualization          | Masonry / Justified     |
| 自由画布     | PixiJS 8                      | GPU 2D Scene Renderer   |
| IPC 数据流  | Tauri Command + Channel       | 请求 + 扫描数据流              |
| 本地缓存索引   | SQLite                        | 可删除的性能缓存                |
| 磁盘缓存     | App Cache Directory           | Thumbnail / Poster      |
| 视觉系统     | CSS Variables + Design Tokens | Runtime Theme           |
| Rust 测试  | cargo test + benchmark        | Core / Infrastructure   |
| TS 测试    | Vitest                        | Layout / Camera / Query |
| E2E      | Playwright / Tauri 集成测试       | 主链                      |

---

# 4. 为什么普通瀑布流和自由画布使用不同 Renderer

这里不建议为了“统一”而强行全部使用一种渲染技术。

## 4.1 瀑布流

传统页面流适合：

```text
Vue
  ↓
Virtual Window
  ↓
DOM
```

原因：

* HTML 图片和文本使用方便；
* hover、菜单、按钮等交互简单；
* CSS 主题系统自然；
* 无障碍能力更好；
* 调试简单。

但是必须进行 virtualization。

Vue 官方同样明确指出，大量列表元素的主要瓶颈是 DOM 数量，并建议大型列表采用虚拟化；对于非常大的数据结构，还可以使用 `shallowRef` / `shallowReactive` 降低深层响应式开销。

---

## 4.2 自由画布

无限二维空间不适合长期维护成：

```text
10000 个绝对定位 DOM
```

推荐：

```text
Free Canvas View
      ↓
Scene Model
      ↓
Spatial Query
      ↓
Visible Scene
      ↓
PixiJS
      ↓
WebGL
```

截至当前 PixiJS 8 同时提供 WebGL 和 WebGPU Renderer，但其官方仍建议生产环境优先 WebGL；WebGPU 后端可作为未来选项。

PixiJS 也具有：

* viewport culling；
* scene graph；
* texture lifecycle；
* texture GC；

这些能力非常符合“大二维场景 + 大量图片 Sprite”的使用场景。

因此正式架构建议：

```text
MasonryView  → DOM Renderer
CanvasView   → Pixi Renderer
```

但两者共享：

```text
MediaSession
MediaQuery
Selection
Layout Model
Resource Service
```

---

# 5. 总体架构

WaterfallViewer 不再单纯描述成传统五层，而采用：

> **Functional Core + View Core + Adapters**

整体结构：

```text
┌──────────────────────────────────────┐
│          Theme / Visual Skin         │
├──────────────────────────────────────┤
│       Vue Presentation Shell         │
│ Panels / Toolbar / Viewer / Dialog   │
├──────────────────────────────────────┤
│              Renderer                │
│     DOM Renderer    Pixi Renderer    │
├──────────────────────────────────────┤
│          View / Layout Core          │
│ Masonry │ Justified │ Canvas │Camera │
│ Virtual Window │ Spatial Index       │
├──────────────────────────────────────┤
│        Frontend Application          │
│ Session │ Query │ Selection │ Viewer │
├──────────────────────────────────────┤
│               Ports                  │
│ MediaPort │ AssetPort │ PlatformPort │
└──────────────────┬───────────────────┘
                   │
             Tauri IPC / Channel
                   │
┌──────────────────▼───────────────────┐
│           Tauri Adapter              │
├──────────────────────────────────────┤
│       Rust Application Layer         │
│ Scan │ Query │ Thumbnail │ Cache     │
├──────────────────────────────────────┤
│          Waterfall Core              │
│ Media Model │ Use Cases │ Ports      │
├──────────────────────────────────────┤
│          Infrastructure              │
│ FS │ Parser │ Thumbnail │ SQLite     │
│ Task Scheduler │ Platform Adapter    │
└──────────────────────────────────────┘
```

---

# 6. Rust Functional Core

建议把 Rust 部分拆成独立 workspace crate。

## 6.1 `waterfall-core`

这是最稳定的一层。

它定义：

### Domain

```text
MediaId
MediaItem
MediaKind
MediaMetadata
MediaSource
MediaRepresentation
ScanSession
MediaQuery
SortRule
FilterRule
```

### Use Cases

```text
StartScan
CancelScan
QueryMedia
RequestRepresentation
GetMediaDetail
InvalidateCache
```

### Ports

```text
MediaScanner
MetadataReader
ThumbnailProvider
CacheRepository
MediaSourceProvider
PlatformService
```

这一 crate：

* 不依赖 Vue；
* 不依赖 TypeScript；
* 不依赖 Tauri command；
* 尽量不依赖具体桌面 OS。

---

# 7. Infrastructure

Infrastructure 实现 Core 定义的 Ports。

```text
infrastructure/
├── filesystem/
├── metadata/
│   ├── image/
│   ├── video/
│   └── audio/
├── thumbnail/
├── cache/
├── scheduler/
└── platform/
```

## 7.1 文件扫描

负责：

* 递归遍历；
* 文件类型初筛；
* symlink 策略；
* 权限错误；
* cancellation；
* batch output。

扫描器只产生“发现了什么”。

它不决定：

* 几列；
* 卡片尺寸；
* 是否圆角；
* 当前 Viewer 是否打开。

---

# 8. Media Pipeline

推荐把整个媒体处理过程理解为 Pipeline，而不是一个函数。

```text
Filesystem Discovery
        ↓
Cheap File Metadata
        ↓
Media Type Detection
        ↓
Header Metadata
        ↓
Session Index
        ↓
Thumbnail / Poster Demand
        ↓
Decode / Resize
        ↓
Disk Cache
        ↓
Frontend Resource
```

---

## 8.1 Fast Path

图片首先只读取足以获得：

```text
width
height
format
orientation
```

的数据。

不应为了得到宽高先完整解码原图。

旧前端原型已经采用了类似思路，对 PNG、GIF、BMP、WebP、JPEG 通过文件头直接尝试获取尺寸，这是应继续保留的性能理念。

正式版本只是把它从 JavaScript 移到 Rust Infrastructure。

---

# 9. 多媒体模型

不要让 `MediaItem` 成为不断追加 nullable 字段的大对象。

推荐：

```ts
type MediaKind =
  | "image"
  | "animated-image"
  | "video"
  | "audio";
```

公共部分：

```ts
interface MediaItem {
  id: MediaId;
  sourceId: SourceId;

  name: string;
  relativePath: string;

  kind: MediaKind;

  fileSize: number;
  modifiedAt?: number;

  visual?: VisualMetadata;
}
```

类型特定 Metadata：

```ts
type MediaDetail =
  | ImageDetail
  | VideoDetail
  | AudioDetail;
```

例如：

```text
Image
 ├─ width
 ├─ height
 └─ orientation

Video
 ├─ width
 ├─ height
 ├─ duration
 ├─ codec
 └─ poster

Audio
 ├─ duration
 ├─ title
 ├─ artist
 └─ cover
```

这样未来新增：

* RAW；
* Live Photo；
* PDF；
* 3D；
* 特殊动画格式；

不会破坏基础模型。

---

# 10. 不把 Path 当成前端资源模型

旧方案中的：

```text
path
displaySrc
thumbPath
```

适合第一阶段，但不适合作为长期边界。

推荐前端认识：

```text
MediaId
RepresentationId
ResourceUri
```

例如：

```ts
interface MediaRepresentation {
  mediaId: string;
  kind: "placeholder" | "thumbnail" | "poster" | "preview" | "original";
  uri: string;
  width: number;
  height: number;
}
```

真实文件路径保留在 Rust / Platform 层。

这样移动端未来不必假设：

```text
Media = C:\xxx\image.jpg
```

因为 Android / iOS 的资源权限和 URI 模型并不等同于桌面路径模型。

Tauri 本身也要求本地文件通过受控 asset protocol / scope 才能安全暴露给 WebView。

---

# 11. Frontend Application Core

前端真正维护的不是文件，而是当前浏览 Session。

```ts
interface MediaSession {
  id: string;
  source: SourceDescriptor;

  scanState: ScanState;

  items: MediaIndex;
  query: MediaQuery;

  selection: SelectionState;
  viewer: ViewerState;

  view: ViewState;
}
```

这里负责：

* 当前目录；
* 扫描进度；
* 排序；
* 过滤；
* selection；
* viewer；
* 当前 view mode。

但不负责：

* 文件 I/O；
* 缩略图生成；
* DOM；
* CSS。

---

# 12. Layout Core

布局是独立的纯逻辑模块。

```text
layout/
├── masonry/
├── justified/
├── canvas/
├── viewport/
└── spatial/
```

## 12.1 Masonry

输入：

```text
MediaVisualInfo[]
Viewport
ColumnCount
Gap
```

输出：

```text
LayoutNode[]
TotalHeight
```

---

## 12.2 Justified

输入类似，但生成：

```text
Row[]
```

而不是列。

旧原型已经同时拥有纵向列模式和横向按比例伸缩模式，因此这两个模式可以作为正式 Layout Strategy 保留，而不是继续存在于 DOM 操作代码中。

---

# 13. Free Canvas Core

自由画布应拥有真正的 World Coordinate System。

```text
World
 ├── MediaNode
 ├── SpatialIndex
 └── Camera
```

Camera：

```ts
interface Camera {
  x: number;
  y: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}
```

MediaNode：

```ts
interface SceneNode {
  mediaId: MediaId;

  x: number;
  y: number;

  width: number;
  height: number;

  zIndex: number;
}
```

核心规则是：

> SceneNode 存储世界坐标，而不是屏幕坐标。

屏幕坐标只是：

```text
World Coordinates
       ↓
Camera Transform
       ↓
Screen Coordinates
```

这样才能真正实现：

* pan；
* zoom；
* minimap；
* jump to item；
* fit selection；
* overview；
* spatial search；
* future animation。

---

# 14. Spatial Index

无限画布不能每帧：

```text
遍历 50,000 个媒体
```

然后判断是否可见。

应该维护：

```text
SpatialIndex
```

查询：

```text
camera visible world rect
             ↓
Spatial Index
             ↓
visible MediaId[]
```

Renderer 只接触：

```text
viewport + overscan
```

范围内的对象。

Spatial Index 的具体实现可以以后选择：

* R-tree；
* quadtree；
* spatial hash。

这里应定义接口，而不是现在把某个算法永久写死。

---

# 15. LOD：自由画布性能核心

媒体资源应至少存在四层显示级别：

```text
LOD 0
Placeholder

LOD 1
Tiny Thumbnail

LOD 2
Normal Thumbnail

LOD 3
Preview / Original
```

根据：

```text
Camera Zoom
+
Projected Screen Size
```

选择 Representation。

例如一个图片当前只占屏幕：

```text
40 × 25 px
```

就没有必要上传：

```text
6000 × 4000
```

纹理。

因此无限画布性能的核心并不是“GPU 足够快”，而是：

> 不让无意义的大资源进入 GPU。

---

# 16. Virtualization

普通瀑布流：

```text
Layout Engine
     ↓
Visible Range
     ↓
Overscan
     ↓
DOM Nodes
```

只创建：

```text
当前视口
+
前后少量 buffer
```

对应的组件。

因此：

```text
MediaItem Count
```

与：

```text
DOM Node Count
```

不应该成正比。

---

# 17. Thumbnail / Resource Manager

建议新增统一 Resource Manager。

职责：

```text
Resource Request
     ↓
Priority Queue
     ↓
Memory Cache
     ↓
Disk Cache
     ↓
Generation
     ↓
Decode
```

优先级建议：

```text
P0 Viewer 当前媒体
P1 当前 viewport
P2 viewport overscan
P3 下一屏预测区域
P4 Background
```

这样用户快速滚动时：

> 已经离开视口的缩略图生成任务不会继续抢占资源。

---

# 18. Cancellation 与 Backpressure

扫描、缩略图、解码都必须支持 cancellation。

例如：

```text
Folder A
  ↓ scanning...

用户立即打开 Folder B

Folder A
  ↓ CANCEL

Folder B
  ↓ START
```

不能让 A 的旧任务继续：

* 消耗磁盘；
* 消耗 CPU；
* 回写 UI；
* 污染当前 session。

所有异步结果都必须绑定：

```text
SessionId
```

旧 Session 的结果直接丢弃。

---

# 19. Cache Architecture

本项目推荐正式引入缓存，但缓存不是媒体数据库。

```text
Media Source
     ↓
Metadata Cache
     ↓
Thumbnail Cache
```

SQLite 可以记录：

```text
path / source key
file size
modified time
media metadata
thumbnail cache key
```

判断：

```text
size + modified_time 未变化
```

则可以快速复用 metadata。

关键原则：

> 删除整个 cache 后，软件仍然完全可用。

因此数据库只是：

```text
Performance Cache
```

而不是：

```text
Source of Truth
```

Source of Truth 始终是用户媒体源。

---

# 20. IPC Architecture

建议正式 IPC 设计：

```text
open_source(...)
start_scan(source, options, channel)
cancel_scan(session_id)

request_representation(media_id, level)
get_media_detail(media_id)

open_external(media_id)
reveal_in_file_manager(media_id)
```

扫描 Channel 可以推：

```text
ScanStarted
BatchFound
Progress
Warning
Finished
Cancelled
```

而不是每发现一个文件就进行一次 IPC。

---

# 21. 视觉系统

功能与视觉真正分离必须落实到代码结构。

推荐：

```text
presentation/
theme/
effects/
```

而不是：

```text
components/
  ButtonBlue.vue
  ButtonGlass.vue
  ImageCardDark.vue
```

---

## 21.1 Design Token

例如：

```css
--wv-color-bg
--wv-color-surface
--wv-color-text
--wv-color-accent

--wv-radius-small
--wv-radius-card

--wv-shadow-card

--wv-spacing-small
--wv-spacing-medium

--wv-motion-fast
--wv-motion-normal
```

组件只读取 Token。

主题决定 Token。

---

# 22. Theme Pack

正式支持：

```text
ThemePack
```

例如：

```text
Default
Minimal
Glass
Dark
High Contrast
Custom
```

Theme 可以运行时切换。

Theme 允许改变：

* color；
* typography；
* radius；
* border；
* shadow；
* blur；
* background；
* animation parameters。

Theme 不允许改变：

* 扫描算法；
* 缓存算法；
* MediaQuery；
* 排序；
* Session；
* 文件权限。

---

# 23. Visual Effects

类似旧原型中的：

* 水波；
* 背景运动；
* blur；
* hover effect；

应变成：

```text
VisualEffect
```

例如：

```text
effects/
├── ripple/
├── parallax-background/
└── ambient-animation/
```

效果可以：

```text
enabled / disabled
```

而不是内嵌到页面运行主链。

这意味着未来甚至可以：

> 完全删除所有动画和美术效果，而不改变软件功能。

这应作为架构验收标准。

---

# 24. Input Abstraction

考虑移动端后，不应该让：

```text
MouseWheel
RightClick
Hover
```

直接成为业务行为。

定义：

```text
Pan
Zoom
Activate
Open
Back
Next
Previous
Select
```

桌面：

```text
Mouse / Keyboard
      ↓
Input Mapping
      ↓
Action
```

移动：

```text
Touch / Gesture
      ↓
Input Mapping
      ↓
Action
```

这样：

```text
pinch gesture
```

和：

```text
Ctrl + Wheel
```

最终都只是：

```text
Zoom
```

---

# 25. 移动端迁移边界

移动端迁移重点不在 Vue 页面，而在：

```text
Source Adapter
Platform Adapter
Input Adapter
Resource Budget
```

桌面 Source：

```text
Filesystem Directory
```

移动端未来可能是：

```text
Document Provider
Photo Library
Scoped Storage
User Selected Directory
```

Core 不应知道这些差异。

因此：

```text
MediaSourceProvider
```

必须是 Port。

Tauri 移动插件当前本身也是 Desktop Rust 与 Mobile Swift/Kotlin 分开实现的模式，与这里的 Adapter 思路一致。

---

# 26. 推荐代码目录

```text
WaterfallViewer/
│
├── crates/
│   ├── waterfall-core/
│   │   └── src/
│   │       ├── domain/
│   │       ├── application/
│   │       └── ports/
│   │
│   └── waterfall-infra/
│       └── src/
│           ├── filesystem/
│           ├── metadata/
│           ├── thumbnail/
│           ├── cache/
│           └── scheduler/
│
├── src-tauri/
│   └── src/
│       ├── commands/
│       ├── ipc/
│       ├── platform/
│       └── lib.rs
│
├── src/
│   ├── application/
│   │   ├── session/
│   │   ├── query/
│   │   ├── viewer/
│   │   └── selection/
│   │
│   ├── layout/
│   │   ├── masonry/
│   │   ├── justified/
│   │   ├── canvas/
│   │   ├── viewport/
│   │   └── spatial/
│   │
│   ├── renderers/
│   │   ├── dom/
│   │   └── pixi/
│   │
│   ├── presentation/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── panels/
│   │   └── viewer/
│   │
│   ├── theme/
│   │   ├── tokens/
│   │   └── themes/
│   │
│   ├── effects/
│   │
│   ├── platform/
│   │   ├── tauri/
│   │   └── input/
│   │
│   └── shared/
│
└── docs/
```

---

# 27. 依赖纪律

必须保持：

```text
Theme
  ↓
Presentation
  ↓
Application / Layout
  ↓
Ports
```

而不能：

```text
Layout → Vue Component
Core → CSS
Rust Scanner → Masonry
Theme → MediaQuery
```

Rust：

```text
Tauri
   ↓
Application
   ↓
Core
   ↑
Infrastructure
```

更准确地说：

> Core 定义 Port，Infrastructure 实现 Port，Application 组织它们，Tauri 只是入口 Adapter。

---

# 28. 性能原则

本项目以后所有性能优化都围绕以下规则。

### Rule 1

**不要完整解码只为了得到尺寸。**

### Rule 2

**不要一次构造所有 DOM。**

### Rule 3

**不要把屏幕外媒体上传到 GPU。**

### Rule 4

**不要给很小的显示区域提供原始大图。**

### Rule 5

**所有后台任务必须有优先级。**

### Rule 6

**所有长任务必须可取消。**

### Rule 7

**缓存必须有明确容量和淘汰策略。**

### Rule 8

**大量媒体数据不要进入 Vue 深层响应式对象树。**

### Rule 9

**布局应该使用 Metadata，而不是等待真实图片加载后再测量。**

### Rule 10

**任何数据流都必须能够处理“结果分批出现”。**

旧原型已经验证了其中若干理念：批量加载、可见性观察、宽高缓存、缩略图缓存和逐批向下加载都是正确方向。

---

# 29. Benchmark 应成为正式工程能力

性能是本项目最复杂的“业务逻辑”，因此不能只凭主观感受。

至少准备：

```text
bench-data/
├── 1k-images/
├── 10k-images/
├── deep-tree/
├── huge-images/
└── mixed-media/
```

观察：

```text
scan time
first batch latency
time to first media
layout time
frame time
DOM count
memory
GPU texture memory
thumbnail queue
cache hit rate
```

未来优化必须回答：

> 优化前是多少，优化后是多少。

而不是：

> 好像流畅了一点。

---

# 30. 测试边界

## Rust Core

重点测试：

* filtering；
* sorting；
* session；
* cache invalidation；
* media classification；
* cancellation。

## Infrastructure

测试：

* recursive scan；
* corrupted files；
* permission errors；
* metadata extraction；
* cache hit/miss。

## Layout

纯函数测试：

```text
given items + viewport
→ expected geometry
```

尤其：

* masonry；
* justified；
* visible range；
* camera transform；
* spatial query。

## Renderer

重点验证：

* mount/unmount；
* virtualization；
* resource release；
* Pixi texture lifecycle。

---

# 31. 当前不推荐的方案

## 31.1 全部逻辑放前端

旧纯前端版本已经说明这种方式可以快速获得 Demo，但文件系统、元数据、DOM、过滤、布局和 Viewer 会逐渐互相纠缠。

正式项目不继续这一方向。

---

## 31.2 全部使用 DOM 实现无限画布

小规模可行，大规模不适合作为正式技术基线。

---

## 31.3 一开始直接自己写 WebGPU Renderer

理论上可以，但当前没有必要。

更适合：

```text
PixiJS
```

先作为 Renderer Adapter。

如果几年后 Renderer 真成为瓶颈，可以：

```text
PixiRenderer
      ↓ replace
Native/WGPU Renderer
```

而 View Core 不变。

Rust 的 `wgpu` 本身确实已经能够跨 Vulkan、Metal、D3D12、OpenGL 等后端运行，因此可以保留为未来极限性能路径，但不应成为当前复杂度来源。

---

# 32. 推荐实现顺序

## Phase A：Core Foundation

完成：

```text
waterfall-core
waterfall-infra
MediaItem
MediaSource
ScanSession
Scanner Port
```

并保证独立测试。

---

## Phase B：Streaming Image Browser

实现：

```text
Folder
↓
Rust Scan
↓
Tauri Channel
↓
Frontend Session
↓
Masonry Layout
↓
Virtualized DOM
```

这里就应正式具备：

* cancellation；
* batch；
* stable geometry。

---

## Phase C：Resource Pipeline

加入：

```text
thumbnail
memory cache
disk cache
SQLite cache index
priority scheduler
```

---

## Phase D：Free Canvas

加入：

```text
Camera
World Coordinates
Spatial Index
LOD
Pixi Renderer
```

此阶段不需要增加复杂业务。

---

## Phase E：Multimedia

逐渐扩展：

```text
Animated Image
Video
Audio
```

并且优先保证：

> 不播放时只展示低成本 Representation。

---

## Phase F：Theme & Runtime Customization

此时把已有视觉正式抽象为：

```text
Design Tokens
Theme Pack
Visual Effect
```

并验证：

> 切换完整视觉语言不修改 Core / Layout / Scan。

---

## Phase G：Mobile Adapter

最后接：

```text
Android Source Adapter
iOS Source Adapter
Touch Input Mapping
Mobile Resource Budget
```

而不是重新设计核心。

---

# 33. 最终架构判断标准

一个新功能加入时，应该可以快速判断它属于哪里。

| 需求                       | 主要位置                              |
| ------------------------ | --------------------------------- |
| 改颜色、圆角、动画                | Theme                             |
| 改卡片组成                    | Presentation                      |
| 改键盘/触摸操作                 | Input Adapter                     |
| 改纵向瀑布布局                  | Layout                            |
| 改自由画布 Camera             | Canvas Core                       |
| 改 GPU 绘制                 | Renderer                          |
| 改排序过滤                    | Application                       |
| 改扫描                      | Rust Application / Infrastructure |
| 改图片解析库                   | Metadata Adapter                  |
| 改缩略图实现                   | Thumbnail Adapter                 |
| 改 Windows / Android 文件访问 | Platform Adapter                  |
| 改 Tauri IPC              | Tauri Adapter                     |

如果未来出现：

```text
改一个背景动画
↓
需要修改 scanner
```

说明架构已经破坏。

如果出现：

```text
增加一个媒体格式
↓
重写 MasonryView
```

也说明边界有问题。

---

# 34. 本版本核心结论

WaterfallViewer 不需要复杂的业务领域模型。

真正需要认真设计的是三件事情：

```text
1. Media Pipeline
2. View / Layout Model
3. Resource Lifecycle
```

因此最合适的总体结构不是一个复杂企业软件式 Domain Architecture，而是：

> **轻量 Functional Core + 清晰 Ports/Adapters + 专门的 View Core + Renderer 解耦。**

最终应形成：

```text
Media Core
    │
    ├──── Desktop
    │
    └──── Mobile

View Core
    │
    ├──── Masonry Renderer
    └──── Canvas Renderer

Presentation
    │
    └──── Theme / Visual Effects
```

这样可以同时满足项目最重要的四个要求：

> **性能可控、视觉可替换、功能可维护、平台可迁移。**
