# 已验证的 LikeC4 用法

固定版本：1.59.4。参考官方 [DSL](https://likec4.dev/dsl/) 和 [CLI](https://likec4.dev/tooling/cli/)；升级前重新跑案例，不能假定导出结构不变。

## 模型和显示

```c4
specification {
  element step { style { color primary; size sm } }
  element decision { style { color amber; size sm } }
  relationship flow { line solid; color gray; multiple true }
  relationship retry { line dashed; color red; multiple true }
}
model {
  draft = step '填写申请' {
    description '''填写申请的完整说明，可用 **Markdown**。'''
    metadata { phase '申请'; source_path 'requirements.md' }
  }
  review = decision '审批是否通过？' {
    description '''核对资料与审批规则。未通过时退回申请人。'''
  }
  draft -[flow]-> review '提交'
  review -[retry]-> draft '退回'
}
views {
  view index {
    title '完整申请流程'
    include *
    include review with { title '审批通过？' }
    style * { size xs; textSize lg; padding xs }
    autoLayout LeftRight 24 16
  }
}
```

- 项目目录的多个 `.c4` 文件合并解析。配置的 `name` 必须明确且不能是 `default`，避免 JSON 导出重复项目。
- 稳定 ID 用简短英文；显示文字可用中文。跨文件用完整路径 `system.api` 引用嵌套元素。
- 自动生成的关系 ID 可能随源文件位置变化。跨版本比较关系时，核对 source、target、条件、类型、样式及重复次数；不要只比较这种自动 ID。
- `description` 存完整说明；metadata 存阶段、标签、原文件路径等。单项 metadata 数组可能导出成字符串，核对时需归一化。
- `include *` 对嵌套结构显示顶层；展开已知容器用 `include user, shop.*, partner.*`。多层嵌套需继续明确包含各层，检查导出的默认视图 ID 集合。独立的 `include **` 在此版本不合法。
- 避免使用 `order` 等语法保留字作 ID；可用 `submit_order` 这样具体的名称。以验证器结果为准。
- `size xs` 让图上以短标题为主，完整内容保留在详情里。导出 draw.io 时脚本修正 xs 框中误显示的长说明，原生 metadata 和原版导出均保留。

## 布局调整顺序

1. 按用户要求和阅读顺序选择 `LeftRight` / `TopBottom`。接受大画布，避免为塞进固定窗口缩小节点和间距。
2. 为阶段创建视图分组；保持模型节点 ID 和说明不变。分组要先于组外的 `include`，元素属于首次加入的分组。不要先写 `include *` 再分组。

```c4
view index {
  group '01 · 申请' {
    color muted
    opacity 8%
    border solid
    include draft, review
  }
  group '02 · 完成' {
    color muted
    opacity 8%
    border solid
    include done
  }
  style * { size xs; textSize lg; padding sm }
  autoLayout TopBottom 60 60
}
```

3. 缩短视图标题，保留完整模型标题和详情。通过项目 `styles.theme.colors` 配置浅色填充、深色文字、柔和边框。局部 UI CSS 可保存在源目录，并在 expected.json 用 `"viewer_css":"flow-theme.css"` 指定，构建时内嵌到最终 HTML；不改依赖包或编译后的业务数据。当前固定 CLI 实测加入 `styles.customCss` 后注册项目失败，使用上述封装入口。
4. 对同一模型父级的节点可写 `rank same { a, b, c }`。`LeftRight` 时约束同列，`TopBottom` 时约束同行。只用于同阶段的局部安排，避免把不同阶段压成无边界的蛇形网格。
5. 用静态检查和看图确认主线、分支、返工线均能追踪，分区标题不被连线遮住。不要删返工线换取整齐。
6. 双向关系贴得过近时，可为正向关系补充符合含义的短视图标签，或调整间距；检查两个箭头方向是否明确。

原 App 案例的紧凑布局和后续纵向布局未满足用户要求。当前使用 7 个对齐的横向分区，全部节点展开。仅换 `LeftRight` 仍可能出现阶段上下错位，不能把方向修改当作对齐完成。

## 固定阶段对齐

LikeC4 1.59.4 支持在 `model/.likec4/index.likec4.snap` 保存原生视图快照。agent 可基于当次自动导出的完整视图调整节点位置、边的 Bézier 点和标签框，保留全部节点、关系和业务说明；不要新增排版用业务节点。

在 expected.json 声明 `"layout":{"mode":"manual","direction":"LR","aligned_groups":true}`。构建通过官方 `LikeC4Model` 应用快照；存在新增/删除节点、边或其他漂移即失败。保留原自动模型为 `exports/model.auto.json`，解析后的 `exports/model.json` 同时供阅读器、检查和静态预览使用。已应用的模型不能再带 `manualLayouts` 重复应用。

手动布局的 SVG/PNG 保留同一份坐标，当前仅支持矩形节点、灰色实线和红色返工线；不支持的图形明确失败。draw.io 通过固定版本的原生导出函数读取同一份已解析模型。CLI 的原始 DOT 仍是自动布局参考，不用于手动布局预览。当前案例的 `layout_horizontal.py` 是该图的排版记录，不是任意图通用路由器。

浅色 HTML 的原生标签可能带 `mix-blend-mode:hard-light`。自定义浅色主题应在 shadow DOM 内将标签混合模式设为 `normal`，明确深色文字和实色底；为中文短条件留足宽度，避免拆成两行。PNG 的颜色正确不能证明 HTML 颜色正确。

## 导出说明

构建采用 `--output-single-file --base ./ --use-hash-history --theme light`，并内嵌残留 favicon。HTML 仍需在浏览器中验证。

单个 `index` 完整视图的大画布可在 expected.json 设置 `"viewer":"reader"`，并声明 `reading.mode="pan-zoom"` 与阅读 `scale`。这个入口复用 LikeC4 官方 `ReactLikeC4` 画布和详情；仅增加阶段导航、从头阅读、总览和缩放按钮，初始按声明比例定位第一阶段。节点坐标、连线与模型直接使用 CLI 导出的 JSON，不重新布局。默认滚动平移，Ctrl/⌘ + 滚轮缩放。外链字体注入已关闭，使用系统中文字体。

阅读入口源文件随发布保存在 `reader-source/`；构建使用固定工具链缓存中的 Vite、React 与 singlefile 插件，不额外安装。仅支持单项目、单个 `index` 视图；多视图继续使用原生入口。浏览器实测仍须覆盖初始化、阶段定位、详情关闭、总览和刷新，不能以编译成功替代。

自动布局的 SVG/PNG 从官方 `gen dot` 输出经固定版本 Graphviz WASM 渲染。默认保留深色预览；浅色项目可在 expected.json 中设置 `"preview": {"theme":"light", "scale":1.25}`。Graphviz 会重新布局，静态预览的配色、字形和部分几何可能不同。手动布局使用上述同坐标预览；两种预览都不能作为 HTML 截图。
