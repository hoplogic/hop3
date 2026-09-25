def clamp(value, low, high, /):
    """Clamp value into the range starting at low."""
    return max(low, min(value, high))
