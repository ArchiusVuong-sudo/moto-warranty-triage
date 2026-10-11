"""The shared result contract: contracts/triage-result.v1.schema.json.

The claims API validates the same file with ajv, so a change to it breaks the
tests on both sides at once.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from jsonschema import Draft7Validator

from .config import CONTRACT_PATH


class ContractError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(CONTRACT_PATH.read_text())
    Draft7Validator.check_schema(schema)
    return schema


def contract_errors(value: Any) -> list[str]:
    validator = Draft7Validator(load_schema())
    return [f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in validator.iter_errors(value)][:10]


def validate_result(value: Any) -> None:
    errors = contract_errors(value)
    if errors:
        raise ContractError(errors)
