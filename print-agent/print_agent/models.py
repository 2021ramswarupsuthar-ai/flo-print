"""Print settings and the three error types used by the agent."""

from dataclasses import dataclass


class ValidationError(ValueError):
    pass


class TemporaryError(RuntimeError):
    pass


class UncertainPrint(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    copies: int = 1
    color: str = "bw"
    orientation: str = "portrait"
