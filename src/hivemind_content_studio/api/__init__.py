"""The control API's routes, one module per subject.

Every module here exposes ``register(app, ctx)``: it builds an ``APIRouter``,
defines the same route functions ``build_control_app`` used to hold inline,
and includes the router on the app at the point control_api.py calls it —
so route registration order, and therefore path matching, is unchanged.

``ctx`` is the :class:`~hivemind_content_studio.api.context.StudioContext`
built by control_api.py: the stores, the per-account resolvers and the
dependencies the routes used to close over.
"""
