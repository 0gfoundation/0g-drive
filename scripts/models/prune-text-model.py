"""Shrink the multilingual text model to the tokens English and Chinese text
can use, for devices with little memory (phones, wallet apps' browsers).

paraphrase-multilingual-MiniLM-L12-v2 has a 250,002-token vocabulary (~100
languages): its word-embedding table is 96 MB of the 118 MB q8 model, and the
17 MB tokenizer.json becomes a large object graph in the page. Keeping every
token made only of ASCII, Latin-1 letters (à–ÿ: accents in English names
and loanwords — café, José, Müller), Chinese characters and CJK / general
punctuation keeps ~116k tokens. Text in those characters can only be split into such
tokens, so English and Chinese text tokenizes to the same pieces and gets
the same embeddings as with the full model (verified by
scripts/models/check-pruned-model.mjs); other scripts become <unk>.

Usage (Python with onnx + numpy, e.g. via uv):
  uv run --with onnx==1.17.0 --with numpy python scripts/models/prune-text-model.py ORIG_DIR OUT_DIR
ORIG_DIR holds the Xenova/paraphrase-multilingual-MiniLM-L12-v2 files
(tokenizer.json, tokenizer_config.json, special_tokens_map.json, config.json,
onnx/model_quantized.onnx); OUT_DIR gets the same files, pruned.
"""
import json
import os
import shutil
import sys

import numpy as np
import onnx
from onnx import numpy_helper

EMBEDDING = 'embeddings.word_embeddings.weight_quantized'


def allowed(c: str) -> bool:
    o = ord(c)
    return (
        o < 0x80  # ASCII
        or 0xC0 <= o <= 0xFF  # Latin-1 letters: café, José, Müller
        or c == '▁'  # SentencePiece's word start
        or 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0xF900 <= o <= 0xFAFF or 0x20000 <= o <= 0x2FA1F  # ideographs
        or 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF or 0x2000 <= o <= 0x206F or 0x2E80 <= o <= 0x2FDF  # punctuation, radicals
    )


def main(src: str, dst: str) -> None:
    tok = json.load(open(os.path.join(src, 'tokenizer.json'), encoding='utf-8'))
    vocab = tok['model']['vocab']
    special = {a['content'] for a in tok['added_tokens']}
    keep = [i for i, (piece, _) in enumerate(vocab) if piece in special or all(allowed(c) for c in piece)]
    new_id = {old: new for new, old in enumerate(keep)}

    tok['model']['vocab'] = [vocab[i] for i in keep]
    tok['model']['unk_id'] = new_id[tok['model']['unk_id']]
    for a in tok['added_tokens']:
        a['id'] = new_id[a['id']]
    for spec in tok['post_processor'].get('special_tokens', {}).values():
        spec['ids'] = [new_id[i] for i in spec['ids']]
    if tok.get('padding') and 'pad_id' in tok['padding']:
        tok['padding']['pad_id'] = new_id[tok['padding']['pad_id']]

    model = onnx.load(os.path.join(src, 'onnx', 'model_quantized.onnx'))
    for i, init in enumerate(model.graph.initializer):
        if init.name == EMBEDDING:
            table = numpy_helper.to_array(init)
            model.graph.initializer[i].CopyFrom(numpy_helper.from_array(np.ascontiguousarray(table[keep]), init.name))
            break
    else:
        raise SystemExit(f'{EMBEDDING} not found')

    os.makedirs(os.path.join(dst, 'onnx'), exist_ok=True)
    json.dump(tok, open(os.path.join(dst, 'tokenizer.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    onnx.save(model, os.path.join(dst, 'onnx', 'model_quantized.onnx'))
    config = json.load(open(os.path.join(src, 'config.json')))
    config['vocab_size'] = len(keep)
    json.dump(config, open(os.path.join(dst, 'config.json'), 'w'), indent=2)
    for f in ('tokenizer_config.json', 'special_tokens_map.json'):
        shutil.copy(os.path.join(src, f), os.path.join(dst, f))
    tc = json.load(open(os.path.join(dst, 'tokenizer_config.json')))
    for k, v in tc.get('added_tokens_decoder', {}).copy().items():
        tc['added_tokens_decoder'].pop(k)
        tc['added_tokens_decoder'][str(new_id[int(k)])] = v
    json.dump(tc, open(os.path.join(dst, 'tokenizer_config.json'), 'w'), indent=2)
    print(f'{len(vocab)} → {len(keep)} tokens; model {os.path.getsize(os.path.join(dst, "onnx", "model_quantized.onnx")) / 1e6:.1f} MB, '
          f'tokenizer {os.path.getsize(os.path.join(dst, "tokenizer.json")) / 1e6:.1f} MB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
