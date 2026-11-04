# Agent 生成 deploy.sh + 管理台 vLLM + 流水线文档

日期：2026-08-21（更新：tool-calling）

## 结论

1. **脚本部署已确认**：sseinfra 用 supervisord 跑仓/包根 `deploy.sh`，不是 compose。  
2. **部署 Agent**：模块页「Agent 生成 deploy.sh」为 **tool-calling 循环**（非一次写死 prompt）。  
   - 工具：`list_dir` / `read_file` / `get_write_boundary` / `write_file` / `done`  
   - **硬边界**：禁止写业务源码；仅配置与部署脚本（白名单强制校验）  
3. **流水线**：见 `docs/plans/2026-08-21-K8s部署流水线.md`。  
4. **管理台**：管理员 → AI/vLLM 端点；模型须支持 OpenAI `tools` / `tool_calls`。

## 配置

- UI：`format=vllm` 时 apiKey 可空；`openai` 必填  
- 或 env：`AGENT_FIXER_BASE_URL` / `AGENT_FIXER_API_KEY` / `AGENT_FIXER_MODEL`  
- 轮次：`DEPLOY_AGENT_MAX_TURNS`（默认 12）  
- 当前端点：`platform_settings.agent_llm_endpoint_id`

## 关键

- `deploy-agent-tools.ts`：白名单 + 工具执行  
- `generate-deploy-sh.ts`：Agent 循环  
- `llm.ts`：`chatCompletionWithTools`
