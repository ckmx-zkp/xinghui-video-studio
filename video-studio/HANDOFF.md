# 星绘视频工坊｜接手说明

## 当前状态

- 前端和 Node 服务入口为 `http://127.0.0.1:4175`。
- ComfyUI/H3 入口为 `http://127.0.0.1:8188`。
- 服务端从 `D:\Home_Work\MiniMax-H3-Local\.env` 读取 MiniMax Token Plan Key；不要把 key 打印到日志、前端或 git。
- M3 分镜接口可用。
- 云端视频流程：额度确认 → Hailuo 2.3 768P/6 秒 → 轮询 → 下载 → FFmpeg 拼接。测试时不要随意提交云端任务。
- **对话导演已接上**：创作页是聊天，不是填表。`POST /api/projects/:id/chat` 由 M3 决定追问、写分镜、改某一镜、生成本地镜头、合并。默认本机草稿，不消耗云端次数。
- 项目会保存到 `outputs/projects/<id>/project.json`（聊天、分镜、每镜参考图、任务 id、成片）。
- **本地 H3 已改为真正排队**：`POST /api/local/generate` 经 ComfyUI `/prompt` 提交 GGUF 工作流，轮询 `/history/{prompt_id}`，成片复制到 `outputs/local/`。不消耗 Token Plan 额度。
- 启动脚本会检测 4175：已占用则只打开浏览器，不重复起 Node；不关闭已运行的 ComfyUI。
- 本机 16GB 路线使用已部署的 GGUF 低显存组合，而不是官方 INT8/NVFP4（约 40GB）。

## 用户测试顺序

1. 双击 `D:\Home_Work\MiniMax-H3-Local\启动_星绘视频工坊.bat`。
2. 确认顶部 `M3 已连接`、`ComfyUI 已连接`，设置页「H3 权重」为已就绪。
3. 先点“生成分镜”（只走 M3，不消耗视频额度）。
4. 切到「本地 H3」，只生成 **一个** 镜头，观察任务变为处理中，完成后出现在预览和 `outputs/local/`。
5. 有云端额度时再测 Hailuo：先一个镜头，再“生成全部镜头”和“合并镜头”。
6. 再双击启动脚本，应只打开浏览器，不出现第二个 Node 窗口。

## 本地 H3 映射

| 工坊输入 | ComfyUI |
|---|---|
| `video_prompt` | `MiniMaxH3ImageToVideo.prompt` |
| 参考图（可选） | 上传到 ComfyUI 后作为 `first_frame` |
| 16:9 / 9:16 / 1:1 | 864×480 / 480×864 / 640×640（0.4MP） |
| 单镜头 6 秒 | `length=141`（24fps 对齐 17k+5） |
| 采样 | Turbo LoRA v4 + 6 步 `simple`，`low_vram=true` |
| CLIP 类型 | `minimax`（不是 `wan`） |

使用的文件：

- `minimax_h3_fl2va_pruned-Q4_K.gguf`
- `qwen3vl-32B-MiniMax-H3-Q2_K.gguf`
- `minimax_h3_video_vae_int8_convrot.safetensors`
- `minimax_h3_audio_vae_bf16.safetensors`
- `minimax_h3_turbo_v4_step600_ema.safetensors`

## 已知限制

- 云端仍固定 Hailuo 2.3、768P、6 秒。
- 16GB 卡上单镜头可能要数分钟到十几分钟；一次只跑一个任务。
- FFmpeg 合并仍是 concat demuxer 无损拼接。
- 官方 INT8/NVFP4 全套未下载，也不适合当前 16GB 方案。

## 关键接口

- `POST /api/local/generate` `{ prompt, firstFrame?, aspect, duration }`
- `GET /api/local/task/:id` 以及统一的 `GET /api/task/:id`
- `GET /api/status` 含 `models.ready` 与各文件是否存在

## 验收命令

```powershell
cd D:\Home_Work\MiniMax-H3-Local\video-studio
npm run build
npm run lint
Invoke-RestMethod http://127.0.0.1:4175/api/status
```

## 安全注意

- 不要读取后输出 `.env` 内容。
- 不要把 Token Plan Key 写入 README、截图、工作流 JSON 或 git。
- 云端“生成全部镜头”会按镜头数消耗额度。
