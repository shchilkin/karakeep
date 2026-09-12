import gc
import json
import os
from pathlib import Path

from contract import MODEL, REVISION, RECIPE, SCHEMA, decode_images, validate_result
from prompt import SYSTEM, TEXT_SYSTEM


class CatalogModel:
    def __init__(self):
        self.model = self.processor = self.tokenizer_data = None

    def load(self):
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig, Qwen3_5ForConditionalGeneration
        from lmformatenforcer.integrations.transformers import build_token_enforcer_tokenizer_data
        directory = Path(os.environ.get('MODEL_DIR', '/models'))
        manifest = json.loads((directory / 'download-manifest.json').read_text())
        if manifest['model'] != MODEL or manifest['revision'] != REVISION:
            raise RuntimeError('model_revision_mismatch')
        if not torch.cuda.is_available():
            raise RuntimeError('cuda_required')
        torch.set_num_threads(2)
        torch.manual_seed(0)
        torch.cuda.set_per_process_memory_fraction(0.78)
        model, loading = Qwen3_5ForConditionalGeneration.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False, output_loading_info=True,
            dtype=torch.bfloat16, device_map={'': 0}, attn_implementation='sdpa', low_cpu_mem_usage=True,
            quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
                llm_int8_skip_modules=['visual', 'lm_head']))
        if any(loading.get(k) for k in ['missing_keys', 'mismatched_keys', 'error_msgs']) or any(
                'mtp.' not in k for k in loading.get('unexpected_keys', [])):
            raise RuntimeError('incompatible_checkpoint')
        self.model = model.eval()
        self.processor = AutoProcessor.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
        self.tokenizer_data = build_token_enforcer_tokenizer_data(self.processor.tokenizer)

    def unload(self):
        self.model = self.processor = self.tokenizer_data = None
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def catalog(self, payload):
        import torch
        from lmformatenforcer import JsonSchemaParser
        from lmformatenforcer.integrations.transformers import build_transformers_prefix_allowed_tokens_fn
        images = decode_images(payload['images'])
        try:
            self.load()
            context = json.dumps({'media': payload['media'], 'source': payload['source']}, ensure_ascii=False)
            messages = [{'role': 'system', 'content': SYSTEM if images else TEXT_SYSTEM},
                        {'role': 'user', 'content': [*[{'type': 'image', 'image': im} for im in images],
                                                    {'type': 'text', 'text': context}]}]
            inputs = self.processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                enable_thinking=False, return_dict=True, return_tensors='pt').to('cuda')
            length = inputs['input_ids'].shape[-1]
            if length > 8192:
                raise ValueError('input_token_limit')
            if 'pixel_values' in inputs:
                inputs['pixel_values'] = inputs['pixel_values'].to(torch.bfloat16)
            constrain = build_transformers_prefix_allowed_tokens_fn(self.tokenizer_data, JsonSchemaParser(SCHEMA))
            with torch.inference_mode():
                generated = self.model.generate(**inputs, max_new_tokens=512, do_sample=False, max_time=85,
                    eos_token_id=self.processor.tokenizer.eos_token_id,
                    pad_token_id=self.processor.tokenizer.pad_token_id or self.processor.tokenizer.eos_token_id,
                    prefix_allowed_tokens_fn=constrain)
            answer = generated[0, length:]
            if len(answer) >= 512 or int(answer[-1]) != self.processor.tokenizer.eos_token_id:
                raise ValueError('truncated_result')
            result = parse_result(self.processor.decode(answer, skip_special_tokens=True).strip())
            return dict(model=MODEL, revision=REVISION, recipe=RECIPE, result=result)
        finally:
            for image in images:
                image.close()


def parse_result(raw):
    return validate_result(json.loads(raw))
