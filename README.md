完整约定（取值方式、`SCHEDULED_CAPS` 清单、调度器门控）见、`SCHEDULED_CAPS` 清单、调度器门控）见主项目
[docs/PLUGIN_DEV.md §3.2](https://github.com/ray5378/MusicFlow/blob/master/docs/PLUGIN_DEV.md)。

## 并行执行（batchParallel）

MusicFlow ≥ v1.13.43 起，宿主把**所有批量任务**（同步 / 导入 / 推荐 / 匹配 / 清理 / 刮削）收进**全局队列**，默认并发上限 = 1（FIFO 串行，全部任务排队）。凡参与批量任务队列的插件——声明了任一 `SCHEDULED_CAPS` 能力（见上节清单）或 `longRunning`——宿主同样在 `registerPlugin()` 统一漏斗里用 `withBatchParallelField()` **统一注入**一个开关到插件配置页（归入「**批量执行**」分组，MusicFlow ≥ v1.13.44 起覆盖内置+外置）：

- `batchParallel` —— 允许并行执行（默认 `false`）：关闭则本插件的批量任务始终参与全局队列串行执行；开启则被计入全局并发上限，可与其它开启此开关的插件**并行执行**（利用多核，更快但 CPU 占用更高）。切换保存即生效，无需重启。

插件侧**无需**为此做任何代码或 manifest 改动（是否声明 `longRunning` 只影响该插件有没有独立 worker 线程，不影响开关是否出现）。完整约定见
[docs/PLUGIN_DEV.md §3.3](https://github.com/ray5378/MusicFlow/blob/master/docs/PLUGIN_DEV.md)。

## 沙箱安全模型（MusicFlow ≥ 1.3.0）"}