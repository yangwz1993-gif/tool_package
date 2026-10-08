/**
 * pi 扩展入口（0 号文件）
 *
 * pi 扫描扩展目录时只认两种情况：目录下的 `*.ts` 文件，或者「子目录里的 index.ts」。
 * 所以这个文件的作用就是让 `plan-handoff/` 整个文件夹放进
 * `~/.pi/agent/extensions/` 之后能被直接加载，实现零配置：
 *   扩展自己所在的目录就是工具目录，同级的 hdo.py 与 skill.md 都能找到。
 *
 * 注册两条命令（实现见 `extensions/handoff.ts`）：
 *   /handoff-read  读：理解当前项目（只读）
 *   /handoff-write 写：新建或更新方案文件
 *
 * 当然也可以只用单文件：把 `extensions/handoff.ts` 拷到
 * `~/.pi/agent/extensions/handoff.ts`，然后按提示填一次工具目录。
 *
 * 开发时直接加载：
 *   pi --extension ./plan-handoff/index.ts
 */

export { default } from "./extensions/handoff";
