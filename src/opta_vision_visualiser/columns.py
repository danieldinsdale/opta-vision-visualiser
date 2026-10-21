"""Canonical column names used in the merged tracking DataFrame."""


class Column:
    PERIOD_ID = "period_id"
    IMPLIED_100HZ_FRAME_COUNT = "implied_100hz_frame_count"
    TRACKING_GROUP_ID = "tracking_group_id"  # 1 = home, 2 = away, 4 = ball
    JERSEY_NUMBER = "jersey_no"
    IS_BALL = "is_ball"
    IS_GOALKEEPER = "is_goalkeeper"

    CONTINUOUS_FRAME_COUNT = "continuous_frame_count"
    IN_PLAY = "in_play"
    BROADCAST_VISIBLE = "broadcast_visible"


BALL_GROUP_ID = 4
