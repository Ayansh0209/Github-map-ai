import { Request, Response, NextFunction } from "express";

export function errorHandler(
    err: any,
    req: Request,
    res: Response,
    next: NextFunction
) {
    const status = err.status || 500;

    res.status(status).json({
        error: {
            message: err.message || "Internal Server Error",
            ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
        },
    });
}