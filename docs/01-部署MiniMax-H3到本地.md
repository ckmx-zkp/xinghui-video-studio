# 部署 MiniMax H3 到本地

面向第一次在这台 Windows 机器上接本地视频模型的 Agent / 开发者。目标不是把官方满血权重塞进 16GB 显卡，而是：**在 RX 9070 XT 上用量化组合稳定跑通「一张图 / 一段提示词 → 一条带声音的短视频」**。

## 1. 框架：H3 在整条产品里扮演什么

```
用户 / 星绘工坊 (4175)
        │  HTTP  /prompt  /history
        ▼
ComfyUI (8188)  ← 本机 GPU 工人
        │
        ▼
MiniMax H3 权重（GGUF + VAE + Turbo LoRA）
```

- **H3 不是对话模型。** 对话导演是云端 MiniMax-M3。H3 只负责把已经写好的镜头提示词（可选首帧图）渲成视频+音频。
- **ComfyUI 是运行时，不是产品界面。** 最终用户不应打开节点图。工坊用 `/prompt` 提交一张固定图。
- **没有 GPU 时，产品前半段（访谈、简报、分镜）仍应能跑。** H3 只挡住「开拍」这一步。

## 2. 设计：为什么是现在这套权重

本机实测硬件：AMD Ryzen 7 9800X3D、约 48GB 内存、RX 9070 XT **16GB**、PyTorch `2.9.1+rocm7.2.1`、架构 `gfx1201`。

官方 pruned INT8 + NVFP4 文本编码器合计约 40GB，不适合当默认。当前约定（16GB 生存组合）：

| 角色 | 文件 | 目录 |
|---|---|---|
| 视频主干 FL2VA | `minimax_h3_fl2va_pruned-Q4_K.gguf` | `models/diffusion_models/` |
| 文本/视觉编码器 | `qwen3vl-32B-MiniMax-H3-Q2_K.gguf` | `models/text_encoders/` |
| 视频 VAE | `minimax_h3_video_vae_int8_convrot.safetensors` | `models/vae/` |
| 音频 VAE | `minimax_h3_audio_vae_bf16.safetensors` | `models/vae/` |
| 少步加速 | `minimax_h3_turbo_v4_step600_ema.safetensors` | `models/loras/` |

要点：

- 用的是 **FL2VA**（首尾帧），不是 **Ref2VA**（身份/声线库）。接镜头用上一镜尾帧更合适，锁角色要另下 ref2va。
- 编码器 Q2_K 很狠：能塞进机器，指令和脸会先糊。画质不够时优先升级编码器，而不是一上来换 Q8 主干。
- CLIP 加载类型必须是 **`minimax`**，不能用 `wan`。接错类型会出片但语义漂。
- 工坊默认 Turbo：**6 步**、`simple` 调度、`low_vram: false`（bypass，更锐、峰值显存略高）。分辨率默认 16:9 → **864×480**，单镜 6 秒对齐 H3 的 `17n+5` 帧网格（约 141 帧）。OOM 时再把 `low_vram` 开回 `true`。

启动参数（`启动_H3_低显存.bat`）：

```text
--windows-standalone-build
--enable-dynamic-vram
--reserve-vram 1
--use-pytorch-cross-attention
--disable-pinned-memory
--fast-disk
```

这些是给 AMD + 16GB 的：动态显存、给桌面留 1GB、不用 pinned memory、权重大时走磁盘。

## 3. 开发 / 部署步骤

### 3.1 准备运行时

1. 安装官方 **ComfyUI Windows portable AMD** 到仓库根目录：`ComfyUI_windows_portable/`（不进 Git，体积太大）。
2. 确认 `python_embeded\python.exe` 能 `import torch` 且 `torch.cuda.get_device_name(0)` 是 RX 9070 XT。
3. 安装自定义节点（已在跑通的机器上可整目录复制）：
   - `ComfyUI-GGUF`
   - `ComfyUI-MiniMax-H3-Turbo`
   - `ComfyUI-KJNodes`（工坊主路径不依赖其节点，但本机工作流里可能有）
   - `ComfyUI-H3-Multishot`（无缝长镜头，工坊默认图暂不用）

必须能加载的节点类：`UnetLoaderGGUF`、`CLIPLoaderGGUF`、`MiniMaxH3ImageToVideo`、`MiniMaxH3TurboLoRA`、`MiniMaxH3TurboSampler`、`VAEDecode`、`VAEDecodeAudio`、`CreateVideo`、`SaveVideo`。

### 3.2 放置模型

按上一节表格放到 `ComfyUI_windows_portable\ComfyUI\models\...`。不要改文件名。工坊按**精确文件名**组图。

### 3.3 启动与手测

1. 双击 `启动_H3_低显存.bat`。
2. 打开 `http://127.0.0.1:8188`，`GET /system_stats` 里应看到 `cuda:0 AMD Radeon RX 9070 XT : native`。
3. 可选：在 ComfyUI 里打开 `user/default/workflows/MiniMax_H3_FL2V_GGUF.json` 做一次手测。
4. 手测建议：I2V、864×480、约 5–6 秒、一次一条、关掉占内存的大软件。
5. 工坊侧看 `GET http://127.0.0.1:4175/api/status`：`comfy: true` 且 `models.ready: true`。

### 3.4 给工坊用的图（不要手搓节点）

`video-studio/server.mjs` 里 `buildH3Prompt` 会提交固定 API 图：加载 GGUF → Turbo LoRA → CLIP `minimax` → 双 VAE → `MiniMaxH3ImageToVideo` → 6 步采样 → 音视频解码 → `SaveVideo`。改节点要同时改这里和验收。

## 4. 完成标准

手测或工坊提交后，同时满足才算 H3 层完成：

- [ ] 8188 常驻，重启会话后能再拉起（本机任务有超时杀进程的问题，见文档 02）。
- [ ] `/api/status` 的 `comfy` 与 `models.ready` 为真。
- [ ] 至少一条真实 mp4 落在 `ComfyUI/output/video/`（或工坊 `outputs/local/`），不是中断任务。
- [ ] 记录单镜耗时。本机 Turbo 6 步、864×480、约 6 秒素材，曾测到采样约 **35 分钟/镜**。排期按这个量级，不要按云端 1 分钟来。
- [ ] 显存不够时一次只跑一条；48GB 内存也要给系统留空。

## 5. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 能出片但人/指令不对 | CLIP 类型写成 `wan` | 改为 `minimax` |
| OOM / 极慢、GPU 占用虚高 | 分辨率或步数过大，或内存被别的软件占满 | 先 864×480、6 步、关 ChatGPT/浏览器 |
| `models.ready: false` | 文件名或目录不对 | 对照表格，不要用官方 40GB 那套当默认 |
| 队列是空的但页面还在「处理中」 | 历史任务中断后没回收 | 看 Comfy `/queue` 和 `/history`，不要重复点开拍 |
| 没有 NVIDIA 的 `nvidia-smi` | 这是 AMD + ROCm | 用 Comfy `/system_stats` 看显存 |

H3 层单独完成，**不等于**产品完成。产品完成看文档 03 的阶段门禁和交付。
