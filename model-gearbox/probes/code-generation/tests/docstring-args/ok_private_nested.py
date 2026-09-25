import json


def _helper(x):
    return x


def outer(items):
    """Process items one by one."""

    def inner(value):
        return value

    class Local:
        def method(self, thing):
            return thing

    return [inner(i) for i in items]


class Box:
    """A box."""

    def _secret(self, key):
        return key

    def __repr__(self):
        return "Box"


CONFIG = json.dumps({"a": 1})
