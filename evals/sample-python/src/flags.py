def parse_flag(text: str) -> bool | None:
    if text == "true":
        return True
    if text == "false":
        return False
    return None
