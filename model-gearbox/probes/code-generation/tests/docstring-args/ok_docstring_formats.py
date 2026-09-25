def page(query, limit, offset):
    '''Return one page of query results.

    Args:
        limit: page size (`limit` must be positive).
        offset: rows to skip (see also: offset_hint).
    '''
    return query[offset:offset + limit]


def pick(options, default=None):
    """Pick from options; fall back to default."""
    return options or default


def noop():
    """Do nothing."""
