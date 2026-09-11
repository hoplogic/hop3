// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// @module: shared-errors ^anc-error-error-code — 错误码与错误类型契约。中稳：新增错误码向后兼容，删/改语义破坏。
// 拆自原 types.ts（见 design/spec-ast.md ^anc-struct-spec-ast 拆分表）。

export enum ErrorCode { // @a: anc-error-error-code
  // Fatal (non-retryable)
  INVALID_STEP_ID = 'INVALID_STEP_ID',
  INVALID_STATE = 'INVALID_STATE',
  SCHEMA_MISMATCH = 'SCHEMA_MISMATCH',
  DEPTH_EXCEEDED = 'DEPTH_EXCEEDED',
  CYCLE_DETECTED = 'CYCLE_DETECTED',
  AUTH_FAILURE = 'AUTH_FAILURE',
  CONTEXT_OVERFLOW = 'CONTEXT_OVERFLOW',
  MISSING_INPUT = 'MISSING_INPUT',
  MAX_TOOL_ITERATIONS = 'MAX_TOOL_ITERATIONS',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  COMMIT_REQUIRED = 'COMMIT_REQUIRED',
  STEP_TIMEOUT = 'STEP_TIMEOUT',
  CORRUPT_STATE_FILE = 'CORRUPT_STATE_FILE', // 状态文件损坏/版本不符——语义收纯:实例目录在而文件缺/坏才是它,目录不存在归 INSTANCE_NOT_FOUND // @a: anc-exec-parallel-join-preconditions
  INSTANCE_NOT_FOUND = 'INSTANCE_NOT_FOUND', // 显式 --instance 的实例目录不存在（典型=实例号手抄错,报文列真实实例指路——契约 hop-cli ^anc-cli-instance-resolve）// @a: anc-cli-instance-resolve

  REPLAN_LIMIT_EXCEEDED = 'REPLAN_LIMIT_EXCEEDED',
  REPLAN_DUPLICATE = 'REPLAN_DUPLICATE',

  // Retryable
  PARSE_ERROR = 'PARSE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  IO_ERROR = 'IO_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  API_TIMEOUT = 'API_TIMEOUT',
  API_NETWORK_ERROR = 'API_NETWORK_ERROR',
  API_SERVER_ERROR = 'API_SERVER_ERROR',
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',
  TOOL_EXEC_ERROR = 'TOOL_EXEC_ERROR',

  // Idempotent hits
  ALREADY_DONE = 'ALREADY_DONE',
  ALREADY_FAILED = 'ALREADY_FAILED',
}

/** Spec 错误联合类型——parser/validator 产出，覆盖解析与校验两类失败。见 [[shared-errors#^anc-error-spec-error]]。 */
export type SpecError = ParseError | ValidationError; // @a: anc-error-spec-error

/** 解析错误——parser 在 markdown → AST 阶段产出，带行号定位。见 [[shared-errors#^anc-error-spec-error]]。 */
export interface ParseError {
  kind: 'parse';
  line: number;
  message: string;
}

/** 校验违规严重度——error 阻塞执行、warn 建议修复、info 提示性（冗余/可优化）。见 [[shared-errors#^anc-error-types]]。 */
export type ValidationSeverity = 'error' | 'warn' | 'info';

/** 校验错误——validator 产出、engine 消费，带规则 ID 与严重度定位违规。见 [[shared-errors#^anc-error-spec-error]]。 */
export interface ValidationError {
  kind: 'validate';
  rule: string;
  severity: ValidationSeverity;
  step_id?: string;
  line?: number;
  message: string;
}
