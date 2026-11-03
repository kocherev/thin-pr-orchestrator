def slugify(title: str) -> str:
    return title.strip().lower().replace(" ", "-")
