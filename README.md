# skills

个人 Skill 仓库：集中管理给 pi（`@mariozechner/pi-coding-agent`）使用的 skills。

## 目录导航

| Skill | 说明 | 状态 | 依赖 |
|-------|------|------|------|
| [kol-questions](kol-questions/) | KOL 内容调研与测试题生成：跨平台（微博/小红书/知乎/公众号）检索 KOL/博主内容 → 子 agent 并行生成可执行测试题 → supervisor 守护 + 预算控制（DS v4，90% 停止线）→ 质量校验 → 输出 Excel | ✅ 可用 | playwright、DS API key、平台 cookie |

## 快速接入 pi

把某个 skill 目录软链/复制到 pi 的 skill 发现目录：

```bash
# 全局（所有项目可用）
ln -s "$(pwd)/kol-questions" ~/.pi/agent/skills/kol-questions
# 或项目级
mkdir -p <项目>/.pi/skills && ln -s "$(pwd)/kol-questions" <项目>/.pi/skills/kol-questions
```

pi 会在需要时按 `SKILL.md` 的 `description` 自动加载对应 skill。

## 添加新 skill 的规范

1. 每个 skill 一个独立子目录，目录名 = skill 名（小写连字符）。
2. 必须有 `SKILL.md`（frontmatter 含 `name` + `description`，遵循 [Agent Skills 规范](https://agentskills.io/specification)）。
3. 不提交敏感文件：`.env`、`*.cookie`、`node_modules/`、`venv`、运行产物（`results/`、`work/`）——用 `.gitignore` 排除。
4. 代码与数据分离：可执行脚本放 `lib/` 或根目录，运行态数据用 `.gitignore` 排除。
5. 每个 skill 目录内带 `README.md`（或复用 SKILL.md）说明用法、依赖、配置。

## 约定

- 依赖的外部服务（API key、cookie）不入库；在 `SKILL.md` 中说明如何获取/配置。
- LLM 调用统一考虑成本：涉及预算的场景提供 `--budget` 控制。
- 保持每个 skill 自包含：不跨目录引用其他 skill 的私有文件。

## 历史

- 2026-08-25：仓库初始化，加入 `kol-questions`（首个 skill，KOL 测试题调研）。
