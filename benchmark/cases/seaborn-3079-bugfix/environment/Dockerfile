FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

RUN python -m pip install --no-cache-dir \
    "flit_core>=3.2,<4" \
    "numpy==1.26.4" \
    "pandas==2.0.3" \
    "matplotlib==3.7.5" \
    "scipy==1.11.4" \
    "pytest==7.4.4"

WORKDIR /workspace

CMD ["bash"]
